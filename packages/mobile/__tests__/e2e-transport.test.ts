/**
 * e2eTransport (portable.dev#13) — the phone half of the HTTP full tunnel.
 *
 * Drives the real shared crypto against a fake PC that answers the handshake +
 * the tunnel with the SAME `@vgit2/shared/e2e` primitives, proving a JSON
 * request round-trips through the AEAD envelope and that a session miss (410)
 * transparently re-handshakes.
 */
import crypto from 'crypto';

// Back the default expo-crypto CSPRNG with Node's for tests without an injected `random`.
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(require('crypto').randomBytes(n)),
}));

import {
  encodeBase64,
  generatePsk,
  openJson,
  respondToHandshake,
  sealJson,
  textToB64,
  type E2eHandshakeInit,
  type E2eInnerRequest,
  type E2eInnerResponse,
  type E2eSessionKeys,
  type E2eTunnelPayload,
} from '@vgit2/shared/e2e';

import { createAuthedFetch } from '../src/features/auth/authedFetch';
import {
  __resetE2eSessions,
  configureE2eSessions,
  createE2eSessionManager,
  dropE2eSession,
  E2eHandshakeHttpError,
  peekE2eSession,
} from '../src/features/api/e2eSessionManager';
import { createE2eFetch } from '../src/features/api/e2eTransport';
import { RelayApiClient } from '../src/features/api/relayClient';
import { renewDataPathToken } from '../src/features/api/renewDataPathToken';
import { GatewayClient } from '../src/services/gatewayClient';

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
const RELAY = 'https://app.portable.dev/t/pc_x';

/**
 * A fake PC that shares `psk` and mirrors E2eSessionService: it completes
 * handshakes and answers tunnelled requests by echoing the inner path. `forget`
 * lets a test force a 410 to exercise the re-handshake path.
 */
function makeFakePc(psk: Uint8Array) {
  const sessions = new Map<string, E2eSessionKeys>();
  let forgetNext = false;
  const seen: E2eInnerRequest[] = [];

  const outerFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    if (url.endsWith('/api/e2e/handshake')) {
      const { message, sessionId, keys } = respondToHandshake(
        psk,
        body as E2eHandshakeInit,
        random
      );
      sessions.set(sessionId, keys);
      return new Response(JSON.stringify(message), { status: 200 });
    }
    if (url.endsWith('/api/e2e')) {
      const payload = body as E2eTunnelPayload;
      if (forgetNext) {
        forgetNext = false;
        return new Response(JSON.stringify({ error: 'x', code: 'e2e_session_unknown' }), {
          status: 410,
        });
      }
      const keys = sessions.get(payload.sid);
      if (!keys) return new Response('{}', { status: 410 });
      const inner = openJson<E2eInnerRequest>(keys.c2s, payload.env);
      seen.push(inner);
      const response: E2eInnerResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyB64: textToB64(JSON.stringify({ echoedPath: inner.path, method: inner.method })),
      };
      return new Response(
        JSON.stringify({ sid: payload.sid, env: sealJson(keys.s2c, response, random) }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected url ${url}`);
  };

  return {
    outerFetch,
    seen,
    forget: () => (forgetNext = true),
    // A PC restart: every established session is gone (any sid now 410s).
    forgetAll: () => sessions.clear(),
  };
}

function makeFetch(psk: Uint8Array, pc: ReturnType<typeof makeFakePc>) {
  return createE2eFetch({
    outerFetch: pc.outerFetch,
    handshakeFetch: pc.outerFetch,
    getPcId: async () => 'pc_x',
    getE2eKey: async () => encodeBase64(psk),
    getRelayBase: async () => RELAY,
    random,
  });
}

describe('createE2eFetch', () => {
  // The transport defaults to the shared module-level session manager — reset between tests.
  afterEach(() => {
    __resetE2eSessions();
  });

  it('tunnels a GET: handshakes once, seals the inner request, returns the decrypted body', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const e2eFetch = makeFetch(psk, pc);

    const res = await e2eFetch(`${RELAY}/api/chats?limit=5`, { method: 'GET' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(await res.text())).toEqual({
      echoedPath: '/api/chats?limit=5',
      method: 'GET',
    });
    // The PC saw the real path, never exposed to the (fake) relay in cleartext.
    expect(pc.seen).toHaveLength(1);
    expect(pc.seen[0].path).toBe('/api/chats?limit=5');
  });

  it('tunnels a POST body through the envelope', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const e2eFetch = makeFetch(psk, pc);

    await e2eFetch(`${RELAY}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'secret chat' }),
    });
    expect(pc.seen[0].method).toBe('POST');
    expect(pc.seen[0].bodyB64).toBe(textToB64(JSON.stringify({ title: 'secret chat' })));
  });

  it('re-handshakes transparently on a 410 session miss and replays', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const e2eFetch = makeFetch(psk, pc);

    // Establish a session.
    await e2eFetch(`${RELAY}/api/me`, { method: 'GET' });
    // Force the next tunnel POST to 410; the transport must re-handshake + replay.
    pc.forget();
    const res = await e2eFetch(`${RELAY}/api/me`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).echoedPath).toBe('/api/me');
  });

  it('a concurrent 410 does not evict the freshly re-handshaken session', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    let handshakes = 0;
    let holdNextTunnel = false;
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    let signalHeld!: () => void;
    const heldReached = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const outerFetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/handshake')) handshakes++;
      if (url.endsWith('/api/e2e') && holdNextTunnel) {
        holdNextTunnel = false;
        signalHeld();
        await held;
      }
      return pc.outerFetch(url, init);
    };
    const e2eFetch = createE2eFetch({
      outerFetch,
      handshakeFetch: outerFetch,
      getPcId: async () => 'pc_x',
      getE2eKey: async () => encodeBase64(psk),
      getRelayBase: async () => RELAY,
      random,
    });

    // Establish S1, then the PC restarts (forgets every session).
    await e2eFetch(`${RELAY}/api/warm`, { method: 'GET' });
    expect(handshakes).toBe(1);
    pc.forgetAll();
    holdNextTunnel = true;

    // B seals with the now-dead S1; its tunnel POST is HELD in flight.
    const b = e2eFetch(`${RELAY}/api/b`, { method: 'GET' });
    await heldReached;

    // A completes the full recovery meanwhile: 410 → evict S1 → handshake S2.
    const a = await e2eFetch(`${RELAY}/api/a`, { method: 'GET' });
    expect(a.status).toBe(200);
    expect(handshakes).toBe(2);
    const recovered = peekE2eSession('pc_x');
    expect(recovered).toBeDefined();

    // B's late 410 is for S1 — it must NOT evict the cached S2.
    releaseHeld();
    const bRes = await b;
    expect(bRes.status).toBe(200);
    expect(handshakes).toBe(2);
    expect(peekE2eSession('pc_x')).toBe(recovered);
  });

  it('reuses one session across multiple requests (single handshake)', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    let handshakes = 0;
    const wrapped = {
      ...pc,
      outerFetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith('/handshake')) handshakes++;
        return pc.outerFetch(url, init);
      },
    };
    const e2eFetch = createE2eFetch({
      outerFetch: wrapped.outerFetch,
      handshakeFetch: wrapped.outerFetch,
      getPcId: async () => 'pc_x',
      getE2eKey: async () => encodeBase64(psk),
      getRelayBase: async () => RELAY,
      random,
    });
    await e2eFetch(`${RELAY}/api/a`, { method: 'GET' });
    await e2eFetch(`${RELAY}/api/b`, { method: 'GET' });
    expect(handshakes).toBe(1);
  });

  it('shares ONE session cache with the socket path: a tunnel 410 drop is visible to peek', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const e2eFetch = makeFetch(psk, pc);

    await e2eFetch(`${RELAY}/api/a`, { method: 'GET' });
    const first = peekE2eSession('pc_x');
    expect(first).toBeDefined();

    pc.forget();
    await e2eFetch(`${RELAY}/api/b`, { method: 'GET' });
    const second = peekE2eSession('pc_x');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('a socket-path drop (dropE2eSession) forces the tunnel to re-handshake', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    let handshakes = 0;
    const countingFetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/handshake')) handshakes++;
      return pc.outerFetch(url, init);
    };
    const e2eFetch = createE2eFetch({
      outerFetch: countingFetch,
      handshakeFetch: countingFetch,
      getPcId: async () => 'pc_x',
      getE2eKey: async () => encodeBase64(psk),
      getRelayBase: async () => RELAY,
      random,
    });

    await e2eFetch(`${RELAY}/api/a`, { method: 'GET' });
    expect(handshakes).toBe(1);
    dropE2eSession('pc_x');
    await e2eFetch(`${RELAY}/api/b`, { method: 'GET' });
    expect(handshakes).toBe(2);
  });

  it('honors an injected private sessionManager (isolated from the shared cache)', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const manager = createE2eSessionManager({
      outerFetch: pc.outerFetch,
      getPcId: async () => 'pc_x',
      getE2eKey: async () => encodeBase64(psk),
      getRelayBase: async () => RELAY,
      random,
    });
    const e2eFetch = createE2eFetch({
      outerFetch: pc.outerFetch,
      handshakeFetch: pc.outerFetch,
      getPcId: async () => 'pc_x',
      getE2eKey: async () => encodeBase64(psk),
      getRelayBase: async () => RELAY,
      random,
      sessionManager: manager,
    });

    const res = await e2eFetch(`${RELAY}/api/me`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(manager.peek('pc_x')).toBeDefined();
    expect(peekE2eSession('pc_x')).toBeUndefined();
  });
});

/**
 * Deadlock guard: a handshake must never ride a renew-armed fetch — the renew
 * awaits `getSession` and the shared manager hands back the SAME in-flight
 * handshake promise (circular await). A handshake 401 must instead surface as
 * `E2eHandshakeHttpError(401)` immediately.
 */
describe('handshake never rides a renew-armed fetch (dead-PSK deadlock)', () => {
  afterEach(() => {
    __resetE2eSessions();
  });

  const STORED = 'header.expired-payload.sig';
  const DEADLOCK = 'DEADLOCK: promise never settled';

  /** A PC whose PSK rotated: every handshake 401s; nothing else is reachable. */
  function makeDeadPskPc() {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/e2e/handshake')) {
        return new Response(JSON.stringify({ error: 'bad mac', code: 'e2e_auth_failed' }), {
          status: 401,
        });
      }
      throw new Error(`unexpected outer request: ${url}`);
    }) as typeof fetch;
    return { fetchImpl, urls };
  }

  /** The production wiring from ApiProvider.buildDefaultClient, seams faked. */
  function buildProductionShapedClient(psk: Uint8Array, pc: ReturnType<typeof makeDeadPskPc>) {
    const gateway = new GatewayClient({ gatewayUrl: 'https://gw.test', fetchImpl: pc.fetchImpl });
    // The module-level session config: authed but NON-renewing (as ApiProvider).
    const handshakeFetch = createAuthedFetch({
      gateway,
      fetchImpl: pc.fetchImpl,
      getToken: async () => STORED,
      persistRenewedToken: async () => {},
    });
    configureE2eSessions({
      outerFetch: handshakeFetch,
      getPcId: async () => 'pc_x',
      getE2eKey: async () => encodeBase64(psk),
      getRelayBase: async () => RELAY,
      random,
    });
    const renew = () =>
      renewDataPathToken({
        fetchImpl: pc.fetchImpl,
        getPcId: async () => 'pc_x',
        getRelayBase: async () => RELAY,
        getStoredToken: async () => STORED,
        persist: async () => {},
        random,
        // `getSession` stays DEFAULT — the shared manager, the deadlock ingredient.
      });
    const client = new RelayApiClient({
      gateway,
      fetchImpl: pc.fetchImpl,
      getRelayUrl: async () => RELAY,
      getToken: async () => STORED,
      persistRenewedToken: async () => {},
      renewOnUnauthorized: renew,
      e2e: {
        getPcId: async () => 'pc_x',
        getE2eKey: async () => encodeBase64(psk),
        getRelayBase: async () => RELAY,
      },
    });
    return { client, renew };
  }

  /** Race `promise` against a deadlock timeout (never an unbounded await). */
  async function settleOrDeadlock(promise: Promise<unknown>): Promise<unknown> {
    let timer!: ReturnType<typeof setTimeout>;
    const outcome = await Promise.race([
      promise.then(
        (value) => ({ resolved: value }),
        (err: unknown) => err
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(DEADLOCK), 2000);
      }),
    ]);
    clearTimeout(timer);
    return outcome;
  }

  it('a client JSON request on a dead PSK REJECTS with E2eHandshakeHttpError(401)', async () => {
    const psk = generatePsk(random);
    const pc = makeDeadPskPc();
    const { client } = buildProductionShapedClient(psk, pc);

    const outcome = await settleOrDeadlock(client.get('/api/chats'));

    expect(outcome).toBeInstanceOf(E2eHandshakeHttpError);
    expect((outcome as E2eHandshakeHttpError).status).toBe(401);
    expect(pc.urls.some((u) => u.includes('/api/e2e/renew'))).toBe(false);
  });

  it('renewDataPathToken through the default session path resolves null (no hang)', async () => {
    const psk = generatePsk(random);
    const pc = makeDeadPskPc();
    const { renew } = buildProductionShapedClient(psk, pc);

    const outcome = await settleOrDeadlock(renew());

    // The PC rejected the handshake (dead PSK) → the terminal re-pair signal.
    expect(outcome).toEqual({ resolved: null });
  });
});
