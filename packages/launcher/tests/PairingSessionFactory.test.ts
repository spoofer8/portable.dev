/**
 * PairingSessionFactory tests (PRD §8, §12.3) — the on-demand fresh-QR mint. Each
 * open/refresh mints a NEW token (fresh jti, future expiry), the payload carries
 * the right pcId/relay/e2eKey, the ephemeral loopback page is (re)served and
 * closed, and the token NEVER reaches the log sink.
 */
import { describe, expect, it } from 'bun:test';

import { decodeAuthToken } from '@vgit2/shared/jwt';

import {
  PairingSessionFactory,
  resolveFreshPairingContext,
  type FreshPairingContext,
} from '../src/PairingSessionFactory.js';
import type { PairingServer } from '../src/PairingServer.js';
import type { ServiceInstallManifest } from '../src/ServiceInstallManifest.js';

function fakeStore(seed: Record<string, string>) {
  const m = new Map(Object.entries(seed));
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v) };
}

const CONTEXT: FreshPairingContext = {
  dataDir: '/tmp/ignored',
  pcId: 'pc_abc',
  gatewayBase: 'https://relay.example',
  wakeCapability: {
    wakeUrl: 'https://server.example.ts.net:8445/v1/wake',
    wakeToken: 'ab'.repeat(32),
  },
};

const STORE_SEED = {
  'launcher:jwt-secret': 'a'.repeat(48),
  'launcher:e2e-psk': 'e2e-psk-base64==',
};

function makeFakeServer() {
  const counters = { started: 0, stopped: 0 };
  const makePairingServer = ((_p: string, _e: string) =>
    ({
      start: async () => {
        counters.started++;
        return 'http://localhost:54321/';
      },
      stop: async () => {
        counters.stopped++;
      },
    }) as unknown as PairingServer) as (payload: string, endpoint: string) => PairingServer;
  return { counters, makePairingServer };
}

describe('PairingSessionFactory.refresh', () => {
  it('builds the payload from the context and serves the ephemeral loopback page', async () => {
    const { counters, makePairingServer } = makeFakeServer();
    const factory = new PairingSessionFactory({
      context: CONTEXT,
      store: fakeStore(STORE_SEED),
      renderQr: async (p) => `QR[${p.length}]`,
      makePairingServer,
    });
    const session = await factory.refresh();
    const payload = JSON.parse(session.payload) as {
      gatewayBase: string;
      pcId: string;
      token: string;
      e2eKey: string;
      wakeUrl: string;
      wakeToken: string;
    };
    expect(payload.gatewayBase).toBe('https://relay.example');
    expect(payload.pcId).toBe('pc_abc');
    expect(payload.e2eKey).toBe('e2e-psk-base64==');
    expect(payload.wakeUrl).toBe(CONTEXT.wakeCapability?.wakeUrl);
    expect(payload.wakeToken).toBe(CONTEXT.wakeCapability?.wakeToken);
    expect(session.qr).toContain('QR[');
    expect(session.loopbackUrl).toBe('http://localhost:54321/');
    expect(counters.started).toBe(1);
    // The token has a future expiry (fixes the 72h staleness, §8.1).
    expect(new Date(session.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('mints a NEW token (fresh jti) on every refresh and closes the prior page', async () => {
    const { counters, makePairingServer } = makeFakeServer();
    const factory = new PairingSessionFactory({
      context: CONTEXT,
      store: fakeStore(STORE_SEED),
      renderQr: async () => 'QR',
      makePairingServer,
    });
    const a = await factory.refresh();
    const b = await factory.refresh();
    const jtiA = decodeAuthToken(JSON.parse(a.payload).token)?.jti;
    const jtiB = decodeAuthToken(JSON.parse(b.payload).token)?.jti;
    expect(jtiA).toBeDefined();
    expect(jtiB).toBeDefined();
    expect(jtiB).not.toBe(jtiA); // a distinct token — a previously expired one can't taint it
    // The second refresh tore down the first ephemeral page before serving a new one.
    expect(counters.started).toBe(2);
    expect(counters.stopped).toBeGreaterThanOrEqual(1);
  });

  it('NEVER writes the token to the log sink (PRD §8.3)', async () => {
    const logs: string[] = [];
    const { makePairingServer } = makeFakeServer();
    const factory = new PairingSessionFactory({
      context: CONTEXT,
      store: fakeStore(STORE_SEED),
      renderQr: async () => 'QR',
      makePairingServer,
      log: (l) => logs.push(l),
    });
    const session = await factory.refresh();
    const token = JSON.parse(session.payload).token as string;
    expect(logs.join('\n')).not.toContain(token);
  });

  it('close() tears the ephemeral page down (idempotent)', async () => {
    const { counters, makePairingServer } = makeFakeServer();
    const factory = new PairingSessionFactory({
      context: CONTEXT,
      store: fakeStore(STORE_SEED),
      renderQr: async () => 'QR',
      makePairingServer,
    });
    await factory.refresh();
    await factory.close();
    expect(counters.stopped).toBe(1);
    await factory.close(); // no page now — must not throw
    expect(counters.stopped).toBe(1);
  });
});

describe('resolveFreshPairingContext', () => {
  it('prefers the install manifest (any cwd rebuilds the daemon config, §5)', () => {
    const manifest: ServiceInstallManifest = {
      schemaVersion: 1,
      installedAt: 'x',
      cliVersion: '3.5.2',
      platform: 'darwin',
      workingDirectory: '/Users/u/app',
      dataDir: '/Users/u/.portable',
      pcId: 'pc_from_manifest',
      pcLabel: 'mini',
      relayBaseUrl: 'https://manifest.relay',
      apiPort: 4300,
      tunnelProvider: 'ngrok',
      forwardedFlags: [],
    };
    expect(resolveFreshPairingContext({ readManifest: () => manifest, env: {} })).toEqual({
      dataDir: '/Users/u/.portable',
      pcId: 'pc_from_manifest',
      gatewayBase: 'https://manifest.relay',
      wakeCapability: undefined,
    });
  });

  it('falls back to the ambient env + stored pcId when there is no manifest', () => {
    const ctx = resolveFreshPairingContext({
      readManifest: () => null,
      env: {
        PORTABLE_PC_ID: 'pc_env',
        PORTABLE_RELAY_URL: 'https://env.relay',
      } as NodeJS.ProcessEnv,
      store: fakeStore({}),
    });
    expect(ctx.pcId).toBe('pc_env');
    expect(ctx.gatewayBase).toBe('https://env.relay');
  });
});
