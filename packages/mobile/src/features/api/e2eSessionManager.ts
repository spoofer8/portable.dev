/**
 * e2eSessionManager — one shared E2E session per connected PC (portable.dev#13).
 *
 * Both transports need the SAME session: the HTTP full tunnel
 * (`e2eTransport`) and the Socket.IO per-frame layer (`useNativeSocket`). This
 * module owns the per-pcId session cache + the PSK-authenticated X25519
 * handshake so a phone handshakes ONCE and both channels share the directional
 * keys. Keys live only in memory (forward secrecy).
 *
 * `configureE2eSessions` wires the runtime seams (the authed outer fetch, the
 * stored PSK reader, the relay-base reader); production calls it from
 * `ApiProvider`. `getOrCreateE2eSession` establishes-or-reuses; `dropE2eSession`
 * is called on a `410` so the next call re-handshakes.
 *
 * {@link createE2eSessionManager} keeps a private cache; {@link sharedE2eSessionManager}
 * is a caller-deps view over the ONE module-level cache, so a tunnel 410
 * eviction is visible to the sealed socket frames and vice versa.
 */
import {
  completeHandshake,
  createHandshakeInit,
  decodeBase64,
  type E2eHandshakeResponse,
  type E2eSession,
} from '@vgit2/shared/e2e';

import { getConnectedPcId } from '../pc-connect/connectedPcStore';
import { getE2eKey } from '../pc-connect/deviceTokenStore';
import { nativeRandomBytes } from './e2eRandom';
import { getRelayUrl } from './relayUrlStore';

export interface E2eSessionDeps {
  /** Outer transport for the handshake POST (the authed fetch). */
  outerFetch: (url: string, init?: RequestInit) => Promise<Response>;
  getPcId?: () => Promise<string | null>;
  getE2eKey?: (pcId: string) => Promise<string | null>;
  getRelayBase?: () => Promise<string>;
  random?: typeof nativeRandomBytes;
}

/** Thrown when the connected PC has no stored E2E key (needs a QR re-scan). */
export class NoE2eKeyError extends Error {
  constructor() {
    super('No E2E key for the connected PC — re-scan the pairing QR');
    this.name = 'NoE2eKeyError';
  }
}

/**
 * Non-2xx handshake answer. Carries the status so callers can classify:
 * 401 = the PC rejected the PSK itself (dead pairing), anything else retryable.
 */
export class E2eHandshakeHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`E2E handshake failed (${status})`);
    this.name = 'E2eHandshakeHttpError';
    this.status = status;
  }
}

/** The cache surface a transport consumes (private or the shared one). */
export interface E2eSessionManager {
  /** Establish or reuse the session for a pcId (defaults to the connected PC). */
  getOrCreate(pcId?: string): Promise<E2eSession>;
  /** Peek the cached session without handshaking (undefined if none). */
  peek(pcId: string): E2eSession | undefined;
  /** Forget a pcId's session so the next `getOrCreate` re-handshakes. */
  drop(pcId: string): void;
}

interface SessionCache {
  sessions: Map<string, E2eSession>;
  inFlight: Map<string, Promise<E2eSession>>;
}

function resolveDeps(d: E2eSessionDeps) {
  return {
    outerFetch: d.outerFetch,
    getPcId: d.getPcId ?? getConnectedPcId,
    getE2eKey: d.getE2eKey ?? getE2eKey,
    getRelayBase: d.getRelayBase ?? (async () => (await getRelayUrl()) ?? ''),
    random: d.random ?? nativeRandomBytes,
  };
}

/** The manager core: `deps` drive the handshake, `cache` holds the sessions. */
function buildManager(d: E2eSessionDeps, cache: SessionCache): E2eSessionManager {
  const deps = resolveDeps(d);

  async function handshake(pcId: string): Promise<E2eSession> {
    const keyB64 = await deps.getE2eKey(pcId);
    if (!keyB64) throw new NoE2eKeyError();
    const relayBase = await deps.getRelayBase();
    const psk = decodeBase64(keyB64);
    const init = createHandshakeInit(psk, deps.random);
    const res = await deps.outerFetch(`${relayBase}/api/e2e/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(init.message),
    });
    if (!res.ok) throw new E2eHandshakeHttpError(res.status);
    const response = (await res.json()) as E2eHandshakeResponse;
    const session = completeHandshake(psk, init.state, response);
    cache.sessions.set(pcId, session);
    return session;
  }

  return {
    async getOrCreate(pcId?: string): Promise<E2eSession> {
      const id = pcId ?? (await deps.getPcId());
      if (!id) throw new Error('No connected PC for E2E session');

      const existing = cache.sessions.get(id);
      if (existing) return existing;

      // Concurrent callers share one in-flight handshake.
      const pending = cache.inFlight.get(id);
      if (pending) return pending;

      const promise = handshake(id).finally(() => cache.inFlight.delete(id));
      cache.inFlight.set(id, promise);
      return promise;
    },
    peek: (pcId: string) => cache.sessions.get(pcId),
    drop: (pcId: string) => {
      cache.sessions.delete(pcId);
    },
  };
}

/** A manager with a PRIVATE cache (isolated from the shared one) — tests. */
export function createE2eSessionManager(d: E2eSessionDeps): E2eSessionManager {
  return buildManager(d, { sessions: new Map(), inFlight: new Map() });
}

// The ONE module-level cache both channels share.
const sharedCache: SessionCache = { sessions: new Map(), inFlight: new Map() };

/**
 * A caller-deps view over the SHARED cache: the transport handshakes with its
 * own seams but stores/evicts in the same map the socket path reads.
 */
export function sharedE2eSessionManager(d: E2eSessionDeps): E2eSessionManager {
  return buildManager(d, sharedCache);
}

let deps: E2eSessionDeps | null = null;

/** Wire the runtime seams (called once by ApiProvider). */
export function configureE2eSessions(d: E2eSessionDeps): void {
  deps = d;
}

/** True once the runtime seams are wired (production). Tests leave it false. */
export function isE2eConfigured(): boolean {
  return deps !== null;
}

/** Test seam: reset all session state + config. */
export function __resetE2eSessions(): void {
  deps = null;
  sharedCache.sessions.clear();
  sharedCache.inFlight.clear();
}

/**
 * Establish or reuse the E2E session for a pcId (defaults to the connected PC).
 * Concurrent callers share one in-flight handshake.
 */
export async function getOrCreateE2eSession(pcId?: string): Promise<E2eSession> {
  if (!deps) throw new Error('E2E sessions not configured');
  return buildManager(deps, sharedCache).getOrCreate(pcId);
}

/** Peek the cached session without handshaking (undefined if none). */
export function peekE2eSession(pcId: string): E2eSession | undefined {
  return sharedCache.sessions.get(pcId);
}

/** Forget a pcId's session (on a 410 or a re-pair) so the next call re-handshakes. */
export function dropE2eSession(pcId: string): void {
  sharedCache.sessions.delete(pcId);
}

/**
 * Drop the connected PC's cached session so the next `getOrCreateE2eSession`
 * re-handshakes (the socket's recovery after the PC rejects a stale `e2eSid`).
 * Best-effort + no-op when unconfigured; resolves the pcId via the wired seam.
 */
export async function dropConnectedE2eSession(): Promise<void> {
  if (!deps) return;
  try {
    const id = await (deps.getPcId ?? getConnectedPcId)();
    if (id) sharedCache.sessions.delete(id);
  } catch {
    // Best-effort — a failed pcId read just means the next handshake re-establishes.
  }
}
