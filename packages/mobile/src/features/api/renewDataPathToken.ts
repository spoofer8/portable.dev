/**
 * renewDataPathToken (portable.dev#24) — PSK-proven re-mint of an expired
 * data-path JWT over the sealed `POST /api/e2e/renew` route.
 *
 * Contract: fresh token (already persisted before the promise resolves);
 * `null` = the PC rejected recovery (re-pair path); throw = transport/storage
 * failure (retryable). Single-flight per pcId lives here, not in the callers.
 * The transport is a PLAIN fetch — never `authedFetch` (it would recurse).
 */
import {
  openJson,
  sealJson,
  type E2eRenewRequest,
  type E2eRenewResponse,
  type E2eSession,
  type E2eTunnelPayload,
} from '@vgit2/shared/e2e';

// File imports (not the pc-connect barrel). The STRICT readers are deliberate:
// a transient keychain failure must throw (retryable), never masquerade as the
// terminal `null` (re-pair).
import { getConnectedPcIdStrict } from '../pc-connect/connectedPcStore';
import { getDeviceTokenStrict, saveDeviceToken } from '../pc-connect/deviceTokenStore';
import { nativeRandomBytes } from './e2eRandom';
import {
  dropE2eSession,
  E2eHandshakeHttpError,
  getOrCreateE2eSession,
  NoE2eKeyError,
  peekE2eSession,
} from './e2eSessionManager';
import { getRelayUrl } from './relayUrlStore';

export interface RenewDataPathTokenDeps {
  /** Underlying fetch — a PLAIN transport (never `authedFetch`: it would recurse). */
  fetchImpl?: typeof fetch;
  getPcId?: () => Promise<string | null>;
  getRelayBase?: () => Promise<string>;
  getStoredToken?: (pcId: string) => Promise<string | null>;
  getSession?: (pcId: string) => Promise<E2eSession>;
  /** Peek the cached session without handshaking (the 410 eviction guard). */
  peekSession?: (pcId: string) => E2eSession | undefined;
  dropSession?: (pcId: string) => void;
  persist?: (token: string) => Promise<void>;
  random?: typeof nativeRandomBytes;
}

// Per-pcId single-flight: concurrent callers share one renew round-trip.
const inFlight = new Map<string, Promise<string | null>>();

/** True when the handshake itself was REJECTED (dead PSK / no key stored). */
function isPairingRejection(err: unknown): boolean {
  if (err instanceof NoE2eKeyError) return true;
  return err instanceof E2eHandshakeHttpError && (err.status === 401 || err.status === 403);
}

async function renewOnce(pcId: string, deps: RenewDataPathTokenDeps): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const random = deps.random ?? nativeRandomBytes;
  const getStoredToken = deps.getStoredToken ?? getDeviceTokenStrict;
  const getSession = deps.getSession ?? getOrCreateE2eSession;
  const peekSession = deps.peekSession ?? peekE2eSession;
  const dropSession = deps.dropSession ?? dropE2eSession;
  const persist = deps.persist ?? ((token: string) => saveDeviceToken(pcId, token));
  const getRelayBase = deps.getRelayBase ?? (async () => (await getRelayUrl()) ?? '');

  const stored = await getStoredToken(pcId);
  if (!stored) return null;

  let session: E2eSession;
  try {
    session = await getSession(pcId);
  } catch (err) {
    if (isPairingRejection(err)) return null;
    throw err;
  }

  const relayBase = await getRelayBase();
  const post = (sess: E2eSession): Promise<Response> =>
    fetchImpl(`${relayBase}/api/e2e/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The relay routes by pcId and never validates the Bearer — an expired JWT passes.
        Authorization: `Bearer ${stored}`,
      },
      credentials: 'omit',
      body: JSON.stringify({
        sid: sess.sessionId,
        env: sealJson(sess.keys.c2s, { token: stored } satisfies E2eRenewRequest, random),
      } satisfies E2eTunnelPayload),
    });

  let res = await post(session);
  if (res.status === 410) {
    // PC forgot the session — re-handshake once, replay once. Evict only while
    // OURS is still cached (a concurrent path may have re-handshaken already).
    if (peekSession(pcId)?.sessionId === session.sessionId) dropSession(pcId);
    try {
      session = await getSession(pcId);
    } catch (err) {
      if (isPairingRejection(err)) return null;
      throw err;
    }
    res = await post(session);
  }
  // 401 = the PC REJECTED the re-mint (bad old-token signature) — re-pair path.
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Data-path renew failed (${res.status})`);

  const body = (await res.json()) as E2eTunnelPayload;
  const { token } = openJson<E2eRenewResponse>(session.keys.s2c, body.env);
  // Persist BEFORE resolving — the caller's replay reads the fresh JWT.
  await persist(token);
  return token;
}

/**
 * Re-mint the pairing JWT against the PSK. Resolves the fresh (persisted)
 * token, `null` when the PC rejected recovery, throws on transport failures.
 */
export async function renewDataPathToken(
  deps: RenewDataPathTokenDeps = {}
): Promise<string | null> {
  const getPcId = deps.getPcId ?? getConnectedPcIdStrict;
  // Strict read: a storage failure throws; only a successful empty read means "no pairing".
  const pcId = await getPcId();
  if (!pcId) return null;

  const pending = inFlight.get(pcId);
  if (pending) return pending;

  const run = renewOnce(pcId, deps).finally(() => inFlight.delete(pcId));
  inFlight.set(pcId, run);
  return run;
}
