/**
 * verifyTunnelAddress (token-validity hardening) — validate that a
 * PC is really reachable AND that the device token will actually be accepted,
 * before marking a connection ready.
 *
 * The app talks to its chosen PC over the stable relay endpoint
 * `<gatewayBase>/t/<pcId>` (the gateway reverse-proxies to the PC's current
 * cloudflared tunnel). The checks happen here, in order:
 *
 *   1. **Liveness / 200+HTML discrimination** — a plain HTTP 200 is NOT proof of
 *      life: a dead tunnel's edge can keep answering `200` with an HTML page, and
 *      the relay deliberately does NOT inspect bodies. So we probe
 *      `GET /api/health` and accept ONLY the backend's real JSON `{ status: 'ok' }`
 *      body (`isHealthyHealthResponse`, shared with the steady-state monitor). A
 *      404 (`unknown pcId`) / 503 (`pc_offline`) / 200-HTML / network error → not
 *      ready.
 *   2. **Token validity (fail-fast)** — `/api/health` is a PUBLIC route on the PC
 *      (the launcher polls it tokenless), so a LIVE health check does NOT prove the
 *      pairing JWT is valid. A token minted with a different `JWT_SECRET` than the
 *      PC validates with (e.g. the api wasn't started by `portable start`) passes
 *      health but then 401s every real request — leaving the user on a broken home
 *      with no clue. So we additionally probe an AUTHED endpoint (`/api/user-settings`,
 *      a cheap local read behind the PC's `jwtMiddleware`): a `401`/`403` means the
 *      PC REJECTED the token → not ready (the caller surfaces a clear error and the
 *      user re-scans / fixes their PC). Any OTHER outcome (2xx/404/5xx/network) is
 *      NOT treated as a rejection — liveness already passed, so a flaky second
 *      request must never block a genuinely-valid token.
 *   3. **Sealed token validity under mandatory E2E** — a mandatory-E2E PC 426s
 *      every plaintext protected request BEFORE auth runs, so step 2 proves
 *      nothing there. With the candidate's PSK (`deps.e2eKey`) a `426` escalates
 *      to a sealed `renewDataPathToken` probe: `null` = rejected → not ready; a
 *      fresh token proves the pairing (persisted — a free slide); a transport
 *      throw keeps step 2's fail-open posture.
 *
 * Used by {@link connectToPc} to gate "ready"; a re-point on rotation
 * is automatic on the next request, so a transient failure just means "probe
 * again".
 */

import {
  completeHandshake,
  createHandshakeInit,
  decodeBase64,
  type E2eHandshakeResponse,
  type E2eSession,
} from '@vgit2/shared/e2e';
import { isHealthyHealthResponse } from '@vgit2/shared/sandbox';

import { relayBaseForPc } from './connectedPcStore';
import { saveDeviceToken } from './deviceTokenStore';

/**
 * Structural mirror of `RenewDataPathTokenDeps` — the renew module is required
 * LAZILY so the api/e2e graph stays out of pc-connect's static imports; keep
 * this shape in lockstep with the pinned interface.
 */
interface SealedRenewDeps {
  fetchImpl?: typeof fetch;
  getPcId?: () => Promise<string | null>;
  getRelayBase?: () => Promise<string>;
  getStoredToken?: (pcId: string) => Promise<string | null>;
  getSession?: (pcId: string) => Promise<E2eSession>;
  peekSession?: (pcId: string) => E2eSession | undefined;
  dropSession?: (pcId: string) => void;
  persist?: (token: string) => Promise<void>;
  random?: (n: number) => Uint8Array;
}

/** The pinned `renewDataPathToken` shape: fresh JWT / null (rejected) / throw (transport). */
type SealedRenewFn = (deps?: SealedRenewDeps) => Promise<string | null>;

export interface VerifyTunnelAddressDeps {
  /** Injectable fetch (defaults to global fetch) — eases testing. */
  fetchImpl?: typeof fetch;
  /**
   * The candidate PC's E2E pre-shared key (base64). With it in hand a `426`
   * escalates to the sealed token check (step 3); absent/null → fail-open.
   */
  e2eKey?: string | null;
  /** Seam: the sealed renew probe. Default: `renewDataPathToken` (lazy-required). */
  renew?: SealedRenewFn;
  /** Seam: CSPRNG for the throwaway handshake. Default: `nativeRandomBytes` (lazy-required). */
  random?: (n: number) => Uint8Array;
}

/**
 * Build the relay health URL for a PC: `<gatewayBase>/t/<pcId>/api/health`.
 * Reuses {@link relayBaseForPc} (the SAME stable base `getRelayUrl()` resolves)
 * so the health probe can never target a different shape than the live data path.
 */
export function relayHealthUrl(gatewayBase: string, pcId: string): string {
  return `${relayBaseForPc(gatewayBase, pcId)}/api/health`;
}

/**
 * Build the relay AUTHED-probe URL: `<gatewayBase>/t/<pcId>/api/user-settings`.
 * A cheap local read behind the PC's `jwtMiddleware` — a `401`/`403` here proves
 * the device token is rejected (token-validity fail-fast, step 2 above).
 */
export function relayAuthCheckUrl(gatewayBase: string, pcId: string): string {
  return `${relayBaseForPc(gatewayBase, pcId)}/api/user-settings`;
}

/** Lazy default for the sealed renew probe — keeps `../api/*` out of the static graph. */
function defaultSealedRenew(deps?: SealedRenewDeps): Promise<string | null> {
  const { renewDataPathToken } = require('../api/renewDataPathToken') as {
    renewDataPathToken: SealedRenewFn;
  };
  return renewDataPathToken(deps);
}

/** Lazy default CSPRNG (expo-crypto) — resolved only when the sealed path runs. */
function defaultRandom(): (n: number) => Uint8Array {
  const { nativeRandomBytes } = require('../api/e2eRandom') as typeof import('../api/e2eRandom');
  return nativeRandomBytes;
}

/**
 * Sealed token-validity probe for the CANDIDATE PC (step 3). Calls
 * `renewDataPathToken` with EXPLICIT deps (never the shared session manager —
 * it is wired by `ApiProvider` and keyed to the CONNECTED pcId), so the session
 * here is a throwaway per-call one.
 */
async function sealedTokenCheck(
  gatewayBase: string,
  pcId: string,
  deviceToken: string,
  e2eKeyB64: string,
  deps: VerifyTunnelAddressDeps
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const relayBase = relayBaseForPc(gatewayBase, pcId);

  try {
    const renew = deps.renew ?? defaultSealedRenew;
    const random = deps.random ?? defaultRandom();
    const psk = decodeBase64(e2eKeyB64);

    let session: E2eSession | null = null;
    const handshake = async (): Promise<E2eSession> => {
      const init = createHandshakeInit(psk, random);
      const res = await fetchImpl(`${relayBase}/api/e2e/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(init.message),
        credentials: 'omit',
      });
      // Same failure shape as e2eSessionManager's handshake (a 401 classifies
      // as "PSK dead"); lazy-required to keep `../api/*` out of the static graph.
      if (!res.ok) {
        const { E2eHandshakeHttpError } =
          require('../api/e2eSessionManager') as typeof import('../api/e2eSessionManager');
        throw new E2eHandshakeHttpError(res.status);
      }
      const response = (await res.json()) as E2eHandshakeResponse;
      return completeHandshake(psk, init.state, response);
    };

    const fresh = await renew({
      fetchImpl,
      random,
      getPcId: async () => pcId,
      getRelayBase: async () => relayBase,
      getStoredToken: async () => deviceToken,
      getSession: async () => (session ??= await handshake()),
      // The 410 eviction guard must see the throwaway session: the default
      // peek (the SHARED cache) never holds this per-call one, and without the
      // seam the 410 recovery would silently replay over the dead session.
      peekSession: () => session ?? undefined,
      dropSession: () => {
        session = null;
      },
      // Candidate-keyed: the renewed JWT lands in THIS pcId's slot (a free slide).
      persist: (token: string) => saveDeviceToken(pcId, token),
    });
    // `null` = the PC REJECTED recovery (dead PSK / dead signature) → invalid.
    return fresh !== null;
  } catch {
    // Transport-shaped failure — "not yet provable", never a rejection (step-2 fail-open).
    return true;
  }
}

/**
 * Validate `pcId` is reachable AND the device token is accepted. Returns `true`
 * only when (1) `GET /api/health` answered with a real `{ status: 'ok' }` body AND
 * (2) the token probe did NOT reject it — plaintext `401`/`403`, or a sealed
 * renew rejection when the plaintext probe answered `426` under mandatory E2E
 * and `deps.e2eKey` is present. Never throws.
 */
export async function verifyTunnelAddress(
  gatewayBase: string,
  pcId: string,
  deviceToken: string,
  deps: VerifyTunnelAddressDeps = {}
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${deviceToken}` };

  // 1. Liveness + 200-HTML discrimination.
  try {
    const res = await fetchImpl(relayHealthUrl(gatewayBase, pcId), {
      method: 'GET',
      headers,
      // Never send or store cookies (parity with GatewayClient).
      credentials: 'omit',
    });
    if (!(await isHealthyHealthResponse(res.clone ? res.clone() : res))) return false;
  } catch {
    // A transport blip is "not yet ready", never a hard failure — the caller
    // re-probes (rotation re-points automatically).
    return false;
  }

  // 2. Token validity (fail-fast). The PC is live; only a clear 401/403 here means
  // it REJECTED the pairing JWT (e.g. a JWT_SECRET mismatch). Anything else is not
  // a rejection — never block a valid token on a flaky second request.
  try {
    const authed = await fetchImpl(relayAuthCheckUrl(gatewayBase, pcId), {
      method: 'GET',
      headers,
      credentials: 'omit',
    });
    if (authed.status === 401 || authed.status === 403) return false;
    // 3. Under mandatory E2E the 426 arrives BEFORE auth runs, so step 2 proved
    // nothing — escalate to the sealed check when the candidate's PSK is in hand.
    if (authed.status === 426 && deps.e2eKey) {
      return await sealedTokenCheck(gatewayBase, pcId, deviceToken, deps.e2eKey, deps);
    }
  } catch {
    // Liveness already passed; a transport error on the authed probe is not a
    // token rejection.
  }
  return true;
}
