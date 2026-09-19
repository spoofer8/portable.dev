/**
 * rev6 QR pairing — save the QR's data-path JWT, then connect.
 *
 * Covers the link/connect client surface (the relay is mocked at the boundary):
 *
 *   - linkPc: SAVE-ONLY — persists the QR's data-path JWT keyed by `pcId` with NO
 *     gateway round-trip (no `/link-pc`, no Clerk session token, no device-token
 *     mint — D16/D19).
 *   - verifyTunnelAddress: (1) body-validates `GET /api/health` through the relay —
 *     true ONLY for 2xx + JSON `{ status: 'ok' }`; a 200-HTML zombie / non-2xx /
 *     network error → false (the 200+HTML discrimination is the app's job). Then
 *     (2) probes the AUTHED `GET /api/user-settings` — a `401`/`403` means the PC
 *     rejected the token (fail-fast, e.g. a JWT_SECRET mismatch) → false; any other
 *     authed outcome (non-401) never blocks a valid token (liveness already passed).
 *     Under mandatory E2E the plaintext probe answers `426`, so with the candidate's
 *     PSK the token check runs SEALED via the renew probe with candidate-scoped deps.
 *   - connectToPc: no stored token → `no-token`; token + healthy → ready; token +
 *     unhealthy → `unhealthy`.
 *
 * Imports from the FILES (not the pc-connect barrel) so the themed scanner graph
 * (useAppTheme → themeStore → MMKV) never loads — only expo-secure-store needs a
 * mock.
 */

// In-memory keychain for deviceTokenStore (expo-secure-store).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

import crypto from 'crypto';

import {
  encodeBase64,
  openJson,
  respondToHandshake,
  sealJson,
  type E2eEnvelope,
  type E2eHandshakeInit,
} from '@vgit2/shared/e2e';

import { createMockGateway } from '../src/test/mockGateway';
import { connectToPc } from '../src/features/pc-connect/connectToPc';
import {
  clearDeviceToken,
  getDeviceToken,
  saveDeviceToken,
  saveE2eKey,
} from '../src/features/pc-connect/deviceTokenStore';
import { linkPc } from '../src/features/pc-connect/linkPc';
import * as verifyTunnelAddressModule from '../src/features/pc-connect/verifyTunnelAddress';
import {
  relayAuthCheckUrl,
  relayHealthUrl,
  verifyTunnelAddress,
  type VerifyTunnelAddressDeps,
} from '../src/features/pc-connect/verifyTunnelAddress';

type SealedRenew = NonNullable<VerifyTunnelAddressDeps['renew']>;
type SealedRenewDeps = NonNullable<Parameters<SealedRenew>[0]>;

const GATEWAY = 'https://app.portable.dev';

const secureStore = jest.requireMock('expo-secure-store') as { __store: Map<string, string> };

afterEach(() => {
  secureStore.__store.clear();
});

describe('linkPc (save-only — rev6)', () => {
  it('persists the QR data-path JWT keyed by pcId via the injected save seam', async () => {
    const saveToken = jest.fn().mockResolvedValue(undefined);

    const result = await linkPc(
      {
        gatewayBase: GATEWAY,
        pcId: 'pc_charlie',
        token: 'pc-minted-jwt',
        deviceLabel: "Bruno's iPhone",
      },
      { saveToken }
    );

    expect(saveToken).toHaveBeenCalledWith('pc_charlie', 'pc-minted-jwt');
    expect(result.pcId).toBe('pc_charlie');
  });

  it('default seam writes the JWT to SecureStore (no gateway round-trip)', async () => {
    const result = await linkPc({
      gatewayBase: GATEWAY,
      pcId: 'pc_charlie',
      token: 'pc-minted-jwt',
    });

    expect(result.pcId).toBe('pc_charlie');
    expect(await getDeviceToken('pc_charlie')).toBe('pc-minted-jwt');
  });

  it('persists the QR e2eKey beside the JWT (portable.dev#13)', async () => {
    const saveToken = jest.fn().mockResolvedValue(undefined);
    const saveE2eKey = jest.fn().mockResolvedValue(undefined);

    await linkPc(
      {
        gatewayBase: GATEWAY,
        pcId: 'pc_charlie',
        token: 'pc-minted-jwt',
        e2eKey: 'psk-base64',
      },
      { saveToken, saveE2eKey }
    );

    expect(saveE2eKey).toHaveBeenCalledWith('pc_charlie', 'psk-base64');
  });

  it('skips the e2eKey save when the input has none (Apple-reviewer path)', async () => {
    const saveE2eKey = jest.fn().mockResolvedValue(undefined);

    await linkPc(
      { gatewayBase: GATEWAY, pcId: 'pc_charlie', token: 'pc-minted-jwt' },
      { saveE2eKey }
    );

    expect(saveE2eKey).not.toHaveBeenCalled();
  });

  it('persists the optional wake capability as one secure value', async () => {
    const replaceWakeCapability = jest.fn().mockResolvedValue(undefined);

    await linkPc(
      {
        gatewayBase: GATEWAY,
        pcId: 'pc_charlie',
        token: 'pc-minted-jwt',
        e2eKey: 'psk-base64',
        wakeUrl: 'https://wake.example.net/v1/wake',
        wakeToken: 'ab'.repeat(32),
      },
      { replaceWakeCapability }
    );

    expect(replaceWakeCapability).toHaveBeenCalledWith('pc_charlie', {
      wakeUrl: 'https://wake.example.net/v1/wake',
      wakeToken: 'ab'.repeat(32),
    });
  });

  it('clears a stale wake capability when a backward-compatible QR omits it', async () => {
    const replaceWakeCapability = jest.fn().mockResolvedValue(undefined);

    await linkPc(
      {
        gatewayBase: GATEWAY,
        pcId: 'pc_charlie',
        token: 'pc-minted-jwt',
        e2eKey: 'psk-base64',
      },
      { replaceWakeCapability }
    );

    expect(replaceWakeCapability).toHaveBeenCalledWith('pc_charlie', null);
  });
});

describe('verifyTunnelAddress', () => {
  /** Register a live PC: `/api/health` ok + `/api/user-settings` accepts the token. */
  function registerLivePc(gateway: ReturnType<typeof createMockGateway>, pcId: string) {
    gateway.on('GET', `/t/${pcId}/api/health`, (req) => {
      expect(req.headers.Authorization ?? req.headers.authorization).toBe('Bearer dt');
      expect(req.credentials).toBe('omit');
      return { status: 200, body: { status: 'ok' } };
    });
    gateway.on('GET', `/t/${pcId}/api/user-settings`, (req) => {
      expect(req.headers.Authorization ?? req.headers.authorization).toBe('Bearer dt');
      expect(req.credentials).toBe('omit');
      return { status: 200, body: { settings: {} } };
    });
  }

  it('returns true when health is { status: "ok" } AND the authed probe is accepted', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerLivePc(gateway, 'pc_alpha');

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(true);

    // Both probes ran, health first.
    const gets = gateway.requests.filter((r) => r.method === 'GET');
    expect(gets[0]?.url).toBe(relayHealthUrl(GATEWAY, 'pc_alpha'));
    expect(gets.some((r) => r.url === relayAuthCheckUrl(GATEWAY, 'pc_alpha'))).toBe(true);
  });

  it('rejects (fail-fast) when the PC 401s the token even though health is live', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({ status: 200, body: { status: 'ok' } }));
    // The PC's jwtMiddleware rejects a JWT_SECRET-mismatched token → 401.
    gateway.on('GET', '/t/pc_alpha/api/user-settings', () => ({
      status: 401,
      body: { error: 'Unauthorized' },
    }));

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(false);
  });

  it('does NOT fail a valid token on a flaky authed probe (non-401 → still ready)', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({ status: 200, body: { status: 'ok' } }));
    gateway.on('GET', '/t/pc_alpha/api/user-settings', () => ({
      status: 500,
      body: { error: 'transient' },
    }));

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(true);
  });

  it('rejects a 200-HTML zombie edge page (no { status: "ok" } body) — no authed probe', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({
      status: 200,
      body: '<html>dead tunnel</html>',
    }));
    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(false);
    // Health failed → the authed probe is never sent.
    expect(gateway.requests.some((r) => r.url === relayAuthCheckUrl(GATEWAY, 'pc_alpha'))).toBe(
      false
    );
  });

  it('rejects a non-2xx health response', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({
      status: 503,
      body: { error: 'offline' },
    }));
    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(false);
  });

  it('returns false (never throws) on a network error', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await expect(verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl })).resolves.toBe(
      false
    );
  });
});

describe('verifyTunnelAddress — sealed token check under mandatory E2E (portable.dev#24)', () => {
  const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
  const PSK = new Uint8Array(32).fill(7);
  const PSK_B64 = encodeBase64(PSK);

  /** A mandatory-E2E PC: live health, but EVERY plaintext protected route → 426. */
  function registerE2ePc(gateway: ReturnType<typeof createMockGateway>, pcId: string) {
    gateway.on('GET', `/t/${pcId}/api/health`, () => ({ status: 200, body: { status: 'ok' } }));
    gateway.on('GET', `/t/${pcId}/api/user-settings`, () => ({
      status: 426,
      body: { error: 'E2E required', code: 'e2e_required' },
    }));
  }

  it('426 + PSK + renew resolves a fresh token → true, with CANDIDATE-scoped deps', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');
    let captured: SealedRenewDeps | undefined;
    const renew = jest.fn(async (deps?: SealedRenewDeps) => {
      captured = deps;
      return 'fresh-jwt';
    });

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', {
        fetchImpl: gateway.fetchImpl,
        e2eKey: PSK_B64,
        renew,
        random,
      })
    ).resolves.toBe(true);

    expect(renew).toHaveBeenCalledTimes(1);
    // The renew probe is pinned to the CANDIDATE PC, never the globally-connected one.
    await expect(captured!.getPcId!()).resolves.toBe('pc_alpha');
    await expect(captured!.getRelayBase!()).resolves.toBe(`${GATEWAY}/t/pc_alpha`);
    await expect(captured!.getStoredToken!('pc_alpha')).resolves.toBe('dt');
    expect(captured!.fetchImpl).toBe(gateway.fetchImpl);
    await captured!.persist!('renewed-jwt');
    expect(await getDeviceToken('pc_alpha')).toBe('renewed-jwt');
  });

  it('426 + renew resolves null (dead PSK or dead signature) → false', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', {
        fetchImpl: gateway.fetchImpl,
        e2eKey: PSK_B64,
        renew: async () => null,
        random,
      })
    ).resolves.toBe(false);
  });

  it('426 + renew THROWS (transport-shaped) → true (liveness passed, keep fail-open)', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', {
        fetchImpl: gateway.fetchImpl,
        e2eKey: PSK_B64,
        renew: async () => {
          throw new Error('relay hiccup');
        },
        random,
      })
    ).resolves.toBe(true);
  });

  it('426 WITHOUT a PSK keeps the fail-open posture (sealed check never attempted)', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');
    const renew = jest.fn(async () => null);

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl, renew })
    ).resolves.toBe(true);

    expect(renew).not.toHaveBeenCalled();
    expect(gateway.requests.some((r) => r.path.endsWith('/api/e2e/handshake'))).toBe(false);
  });

  it('getSession runs a throwaway PSK handshake against the candidate relay; dropSession re-handshakes', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');
    const pcSessionIds: string[] = [];
    gateway.on('POST', '/t/pc_alpha/api/e2e/handshake', (req) => {
      const { message, sessionId } = respondToHandshake(PSK, req.body as E2eHandshakeInit, random);
      pcSessionIds.push(sessionId);
      return { status: 200, body: message };
    });
    let captured: SealedRenewDeps | undefined;
    const renew = jest.fn(async (deps?: SealedRenewDeps) => {
      captured = deps;
      return 'fresh-jwt';
    });

    await verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', {
      fetchImpl: gateway.fetchImpl,
      e2eKey: PSK_B64,
      renew,
      random,
    });

    const s1 = await captured!.getSession!('pc_alpha');
    const s2 = await captured!.getSession!('pc_alpha');
    expect(s2).toBe(s1);
    expect(pcSessionIds).toEqual([s1.sessionId]);

    captured!.dropSession!('pc_alpha');
    const s3 = await captured!.getSession!('pc_alpha');
    expect(pcSessionIds).toHaveLength(2);
    expect(s3.sessionId).toBe(pcSessionIds[1]);
  });

  it('exposes peekSession over the SAME throwaway session (the 410 eviction guard can fire)', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');
    gateway.on('POST', '/t/pc_alpha/api/e2e/handshake', (req) => {
      const { message } = respondToHandshake(PSK, req.body as E2eHandshakeInit, random);
      return { status: 200, body: message };
    });
    let captured: SealedRenewDeps | undefined;
    await verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', {
      fetchImpl: gateway.fetchImpl,
      e2eKey: PSK_B64,
      renew: async (deps?: SealedRenewDeps) => {
        captured = deps;
        return 'fresh-jwt';
      },
      random,
    });

    expect(captured!.peekSession!('pc_alpha')).toBeUndefined();
    const s1 = await captured!.getSession!('pc_alpha');
    // peekSession must reflect the throwaway session, not the shared manager's
    // (empty) cache — renewOnce's 410 eviction guard compares against it.
    expect(captured!.peekSession!('pc_alpha')).toBe(s1);
    captured!.dropSession!('pc_alpha');
    expect(captured!.peekSession!('pc_alpha')).toBeUndefined();
    const s2 = await captured!.getSession!('pc_alpha');
    expect(captured!.peekSession!('pc_alpha')).toBe(s2);
    expect(s2).not.toBe(s1);
  });

  it('410-then-success renew recovers with exactly one re-handshake and persists the fresh token', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');
    // A PSK-speaking PC that restarted after the throwaway handshake: the first
    // renew hits a forgotten session (410).
    const pcSessions = new Map<string, { c2s: Uint8Array; s2c: Uint8Array }>();
    const handshakeIds: string[] = [];
    gateway.on('POST', '/t/pc_alpha/api/e2e/handshake', (req) => {
      const { message, sessionId, keys } = respondToHandshake(
        PSK,
        req.body as E2eHandshakeInit,
        random
      );
      pcSessions.set(sessionId, keys);
      handshakeIds.push(sessionId);
      return { status: 200, body: message };
    });
    const renewSids: string[] = [];
    gateway.on('POST', '/t/pc_alpha/api/e2e/renew', (req) => {
      const { sid, env } = req.body as { sid: string; env: E2eEnvelope };
      renewSids.push(sid);
      if (renewSids.length === 1) {
        pcSessions.delete(sid);
        return { status: 410, body: { error: 'unknown e2e session' } };
      }
      const keys = pcSessions.get(sid);
      if (!keys) return { status: 410, body: { error: 'unknown e2e session' } };
      const { token } = openJson<{ token: string }>(keys.c2s, env);
      expect(token).toBe('dt');
      return {
        status: 200,
        body: { sid, env: sealJson(keys.s2c, { token: 'fresh-jwt' }, random) },
      };
    });

    // No `renew` injected: the real default renewDataPathToken runs against the candidate deps.
    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', {
        fetchImpl: gateway.fetchImpl,
        e2eKey: PSK_B64,
        random,
      })
    ).resolves.toBe(true);

    expect(handshakeIds).toHaveLength(2);
    expect(renewSids).toEqual([handshakeIds[0], handshakeIds[1]]);
    await expect(getDeviceToken('pc_alpha')).resolves.toBe('fresh-jwt');
  });

  it('a 401 handshake (dead PSK) surfaces from getSession in the e2eSessionManager failure shape', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerE2ePc(gateway, 'pc_alpha');
    gateway.on('POST', '/t/pc_alpha/api/e2e/handshake', () => ({
      status: 401,
      body: { error: 'bad PSK MAC' },
    }));
    let captured: SealedRenewDeps | undefined;
    await verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', {
      fetchImpl: gateway.fetchImpl,
      e2eKey: PSK_B64,
      renew: async (deps?: SealedRenewDeps) => {
        captured = deps;
        return null;
      },
      random,
    });

    await expect(captured!.getSession!('pc_alpha')).rejects.toThrow('E2E handshake failed (401)');
  });
});

describe('connectToPc', () => {
  it('returns no-token when this device never linked the PC (no first-connection report)', async () => {
    await clearDeviceToken('pc_alpha');
    const verify = jest.fn();
    const reportFirstConnection = jest.fn();
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify,
      reportFirstConnection,
    });
    expect(result).toEqual({ ready: false, deviceToken: null, reason: 'no-token' });
    expect(verify).not.toHaveBeenCalled();
    expect(reportFirstConnection).not.toHaveBeenCalled();
  });

  it('connects straight (ready) when a stored token health-validates AND reports the first connection once', async () => {
    await saveDeviceToken('pc_alpha', 'stored-dt');
    const verify = jest.fn().mockResolvedValue(true);
    const reportFirstConnection = jest.fn();
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify,
      reportFirstConnection,
    });
    expect(verify).toHaveBeenCalledWith(GATEWAY, 'pc_alpha', 'stored-dt');
    expect(result).toEqual({ ready: true, deviceToken: 'stored-dt' });
    // Fire-and-forget activation report (D37) fired EXACTLY once with the pcId.
    expect(reportFirstConnection).toHaveBeenCalledTimes(1);
    expect(reportFirstConnection).toHaveBeenCalledWith('pc_alpha');
  });

  it('still returns ready even if the first-connection report throws (never blocks the connect)', async () => {
    await saveDeviceToken('pc_alpha', 'stored-dt');
    const reportFirstConnection = jest.fn(() => {
      throw new Error('report boom');
    });
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify: async () => true,
      reportFirstConnection,
    });
    expect(result).toEqual({ ready: true, deviceToken: 'stored-dt' });
    expect(reportFirstConnection).toHaveBeenCalledTimes(1);
  });

  it('default verify carries the stored e2eKey (enables the sealed check on a mandatory-E2E PC)', async () => {
    const verifySpy = jest
      .spyOn(verifyTunnelAddressModule, 'verifyTunnelAddress')
      .mockResolvedValue(true);
    try {
      await saveDeviceToken('pc_alpha', 'stored-dt');
      await saveE2eKey('pc_alpha', 'psk-base64');
      const result = await connectToPc('pc_alpha', {
        gatewayBase: GATEWAY,
        reportFirstConnection: jest.fn(),
      });
      expect(result.ready).toBe(true);
      expect(verifySpy).toHaveBeenCalledWith(
        GATEWAY,
        'pc_alpha',
        'stored-dt',
        expect.objectContaining({ e2eKey: 'psk-base64' })
      );
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('reports unhealthy when the stored token fails the health probe (no first-connection report)', async () => {
    await saveDeviceToken('pc_alpha', 'stored-dt');
    const verify = jest.fn().mockResolvedValue(false);
    const reportFirstConnection = jest.fn();
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify,
      reportFirstConnection,
    });
    expect(result).toEqual({ ready: false, deviceToken: 'stored-dt', reason: 'unhealthy' });
    expect(reportFirstConnection).not.toHaveBeenCalled();
  });
});
