/**
 * renewDataPathToken — PSK-proven re-mint of an expired data-path JWT over the
 * sealed `POST /api/e2e/renew` route. The fake PC drives the REAL shared crypto:
 * handshake out-of-band, open the c2s envelope, seal a fresh JWT s2c.
 */
import crypto from 'crypto';

// Mock keychain for the STRICT default readers: a key in `__failing` throws on read.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  const failing = new Set<string>();
  return {
    __store: store,
    __failing: failing,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => {
      if (failing.has(key)) throw new Error('keychain unavailable');
      return store.get(key) ?? null;
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

import {
  completeHandshake,
  createHandshakeInit,
  generatePsk,
  openJson,
  respondToHandshake,
  sealJson,
  type E2eRenewRequest,
  type E2eSession,
  type E2eSessionKeys,
  type E2eTunnelPayload,
} from '@vgit2/shared/e2e';

import { E2eHandshakeHttpError, NoE2eKeyError } from '../src/features/api/e2eSessionManager';
import {
  renewDataPathToken,
  type RenewDataPathTokenDeps,
} from '../src/features/api/renewDataPathToken';
import { CONNECTED_PC_KEY } from '../src/features/pc-connect/connectedPcStore';
import { DEVICE_TOKEN_KEY_PREFIX } from '../src/features/pc-connect/deviceTokenStore';

interface SecureStoreMock {
  __store: Map<string, string>;
  __failing: Set<string>;
}

const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
const RELAY = 'https://app.portable.dev/t/pc_x';
const RENEW_URL = `${RELAY}/api/e2e/renew`;
const STORED = 'header.expired-payload.sig';
const FRESH = 'header.fresh-payload.sig';

/** Complete a handshake out-of-band: the phone session + the PC's key view. */
function makeSessionPair(psk: Uint8Array): { session: E2eSession; pcKeys: E2eSessionKeys } {
  const init = createHandshakeInit(psk, random);
  const { message, keys } = respondToHandshake(psk, init.message, random);
  return { session: completeHandshake(psk, init.state, message), pcKeys: keys };
}

/** A 200 renew response sealing `token` s2c for `sid`. */
function renewOk(pcKeys: E2eSessionKeys, sid: string, token: string): Response {
  return new Response(JSON.stringify({ sid, env: sealJson(pcKeys.s2c, { token }, random) }), {
    status: 200,
  });
}

/** Deps that resolve a healthy pairing; tests override the interesting seams. */
function baseDeps(overrides: Partial<RenewDataPathTokenDeps>): RenewDataPathTokenDeps {
  return {
    getPcId: async () => 'pc_x',
    getRelayBase: async () => RELAY,
    getStoredToken: async () => STORED,
    dropSession: () => {},
    persist: async () => {},
    random,
    ...overrides,
  };
}

describe('renewDataPathToken', () => {
  it('seals the stored token c2s, opens the fresh token s2c, persists then resolves', async () => {
    const psk = generatePsk(random);
    const { session, pcKeys } = makeSessionPair(psk);
    const persisted: string[] = [];
    const seenAuth: Array<string | undefined> = [];

    const fetchImpl = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(RENEW_URL);
      seenAuth.push((init?.headers as Record<string, string>).Authorization);
      const payload = JSON.parse(init?.body as string) as E2eTunnelPayload;
      expect(payload.sid).toBe(session.sessionId);
      const req = openJson<E2eRenewRequest>(pcKeys.c2s, payload.env);
      expect(req.token).toBe(STORED);
      return renewOk(pcKeys, payload.sid, FRESH);
    }) as unknown as typeof fetch;

    const result = await renewDataPathToken(
      baseDeps({
        fetchImpl,
        getSession: async () => session,
        persist: async (t) => {
          persisted.push(t);
        },
      })
    );

    expect(result).toBe(FRESH);
    // Persisted BEFORE resolving — the caller's replay reads the fresh JWT.
    expect(persisted).toEqual([FRESH]);
    // The stored (expired) Bearer still rides the POST (relay parity).
    expect(seenAuth).toEqual([`Bearer ${STORED}`]);
  });

  it('on a 410 drops the session, re-handshakes ONCE and replays ONCE', async () => {
    const psk = generatePsk(random);
    const stale = makeSessionPair(psk);
    const live = makeSessionPair(psk);
    const dropped: string[] = [];
    let handshakes = 0;
    let cached = stale.session;
    const getSession = async () => {
      cached = ++handshakes === 1 ? stale.session : live.session;
      return cached;
    };

    const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(init?.body as string) as E2eTunnelPayload;
      if (payload.sid === stale.session.sessionId) {
        return new Response(JSON.stringify({ error: 'unknown', code: 'e2e_session_unknown' }), {
          status: 410,
        });
      }
      const req = openJson<E2eRenewRequest>(live.pcKeys.c2s, payload.env);
      expect(req.token).toBe(STORED);
      return renewOk(live.pcKeys, payload.sid, FRESH);
    }) as unknown as typeof fetch;

    const result = await renewDataPathToken(
      baseDeps({
        fetchImpl,
        getSession,
        peekSession: () => cached,
        dropSession: (pcId) => {
          dropped.push(pcId);
        },
      })
    );

    expect(result).toBe(FRESH);
    expect(handshakes).toBe(2);
    expect(dropped).toEqual(['pc_x']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a 410 does not evict a session another path already re-established', async () => {
    const psk = generatePsk(random);
    const stale = makeSessionPair(psk);
    const live = makeSessionPair(psk);
    const dropped: string[] = [];
    let calls = 0;
    const getSession = async () => (++calls === 1 ? stale.session : live.session);

    const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(init?.body as string) as E2eTunnelPayload;
      if (payload.sid === stale.session.sessionId) {
        return new Response(JSON.stringify({ error: 'unknown', code: 'e2e_session_unknown' }), {
          status: 410,
        });
      }
      return renewOk(live.pcKeys, payload.sid, FRESH);
    }) as unknown as typeof fetch;

    const result = await renewDataPathToken(
      baseDeps({
        fetchImpl,
        getSession,
        peekSession: () => live.session,
        dropSession: (pcId) => {
          dropped.push(pcId);
        },
      })
    );

    expect(result).toBe(FRESH);
    expect(dropped).toEqual([]);
  });

  it('resolves null when the PC rejects the re-mint (401 e2e_renew_rejected)', async () => {
    const psk = generatePsk(random);
    const { session } = makeSessionPair(psk);
    const persist = jest.fn(async () => {});
    const fetchImpl = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: 'bad signature', code: 'e2e_renew_rejected' }), {
          status: 401,
        })
    ) as unknown as typeof fetch;

    const result = await renewDataPathToken(
      baseDeps({ fetchImpl, getSession: async () => session, persist })
    );

    expect(result).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it('resolves null when the handshake is rejected with 401 (PSK dead)', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const result = await renewDataPathToken(
      baseDeps({
        fetchImpl,
        getSession: async () => {
          throw new E2eHandshakeHttpError(401);
        },
      })
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves null when no E2E key is stored for the pairing', async () => {
    const result = await renewDataPathToken(
      baseDeps({
        fetchImpl: jest.fn() as unknown as typeof fetch,
        getSession: async () => {
          throw new NoE2eKeyError();
        },
      })
    );
    expect(result).toBeNull();
  });

  it('resolves null when no PC is connected', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const result = await renewDataPathToken(
      baseDeps({
        fetchImpl,
        getPcId: async () => null,
        getSession: async () => {
          throw new Error('must not handshake');
        },
      })
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves null when the pairing has no stored JWT', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const result = await renewDataPathToken(
      baseDeps({
        fetchImpl,
        getStoredToken: async () => null,
        getSession: async () => {
          throw new Error('must not handshake');
        },
      })
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a network failure (retryable — nothing was decided)', async () => {
    const psk = generatePsk(random);
    const { session } = makeSessionPair(psk);
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;

    await expect(
      renewDataPathToken(baseDeps({ fetchImpl, getSession: async () => session }))
    ).rejects.toThrow('Network request failed');
  });

  it('throws on an unexpected renew status (5xx)', async () => {
    const psk = generatePsk(random);
    const { session } = makeSessionPair(psk);
    const fetchImpl = jest.fn(
      async () => new Response('bad gateway', { status: 502 })
    ) as unknown as typeof fetch;

    await expect(
      renewDataPathToken(baseDeps({ fetchImpl, getSession: async () => session }))
    ).rejects.toThrow('Data-path renew failed (502)');
  });

  it('single-flight: concurrent callers share one renew round-trip', async () => {
    const psk = generatePsk(random);
    const { session, pcKeys } = makeSessionPair(psk);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      const payload = JSON.parse(init?.body as string) as E2eTunnelPayload;
      return renewOk(pcKeys, payload.sid, FRESH);
    }) as unknown as typeof fetch;
    const deps = baseDeps({ fetchImpl, getSession: async () => session });

    const first = renewDataPathToken(deps);
    const second = renewDataPathToken(deps);
    release();

    await expect(first).resolves.toBe(FRESH);
    await expect(second).resolves.toBe(FRESH);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * null = terminal "PC rejected / no pairing" (re-pair); a TRANSIENT storage
 * failure must THROW (retryable) — never masquerade as a dead pairing.
 */
describe('renewDataPathToken strict storage defaults', () => {
  beforeEach(() => {
    secureStore.__store.clear();
    secureStore.__failing.clear();
  });

  const neverHandshake = async (): Promise<never> => {
    throw new Error('must not handshake');
  };

  it('rejects (not null) when the connected-pc read fails', async () => {
    secureStore.__failing.add(CONNECTED_PC_KEY);

    await expect(
      renewDataPathToken({
        fetchImpl: jest.fn() as unknown as typeof fetch,
        getRelayBase: async () => RELAY,
        getStoredToken: async () => STORED,
        getSession: neverHandshake,
      })
    ).rejects.toThrow('keychain unavailable');
  });

  it('rejects (not null) when the stored-JWT read fails', async () => {
    secureStore.__failing.add(`${DEVICE_TOKEN_KEY_PREFIX}pc_x`);

    await expect(
      renewDataPathToken({
        fetchImpl: jest.fn() as unknown as typeof fetch,
        getPcId: async () => 'pc_x',
        getRelayBase: async () => RELAY,
        getSession: neverHandshake,
      })
    ).rejects.toThrow('keychain unavailable');
  });

  it('a SUCCESSFUL empty connected-pc read still resolves null (no pairing)', async () => {
    const result = await renewDataPathToken({
      fetchImpl: jest.fn() as unknown as typeof fetch,
      getRelayBase: async () => RELAY,
      getSession: neverHandshake,
    });
    expect(result).toBeNull();
  });

  it('a SUCCESSFUL empty stored-JWT read still resolves null (pairing without a JWT)', async () => {
    secureStore.__store.set(CONNECTED_PC_KEY, 'pc_x');
    const result = await renewDataPathToken({
      fetchImpl: jest.fn() as unknown as typeof fetch,
      getRelayBase: async () => RELAY,
      getSession: neverHandshake,
    });
    expect(result).toBeNull();
  });
});
