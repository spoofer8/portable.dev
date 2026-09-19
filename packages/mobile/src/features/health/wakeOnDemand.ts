/**
 * Wake-on-demand client for a sleeping paired Mac.
 *
 * The QR supplies a private HTTPS endpoint and opaque bearer. Both live in
 * SecureStore. This module intentionally has no logging: transport failures are
 * represented only by a coarse result so the bearer cannot reach console or
 * telemetry through an interpolated error.
 */

import { getConnectedPcId } from '../pc-connect/connectedPcStore';
import { getWakeCapability, type WakeCapability } from '../pc-connect/deviceTokenStore';

export type WakeRequestResult = 'requested' | 'failed' | 'unavailable' | 'already-requested';

export interface RequestConnectedPcWakeDeps {
  getPcId?: () => Promise<string | null>;
  getCapability?: (pcId: string) => Promise<WakeCapability | null>;
  fetchImpl?: typeof fetch;
  /** Called immediately before the authenticated POST, for user-facing status only. */
  onRequest?: () => void;
  /** Per-request timeout signal seam. */
  timeoutSignal?: (ms: number) => AbortSignal | undefined;
}

/** A wake relay should acknowledge quickly even though the Mac wakes asynchronously. */
export const WAKE_REQUEST_TIMEOUT_MS = 10_000;

function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } })
    .AbortSignal;
  return typeof ctor?.timeout === 'function' ? ctor.timeout(ms) : undefined;
}

/** PCs for which a wake POST has already been made during the current outage. */
const requestedForOutage = new Set<string>();

/** Release the once-per-outage latch after health succeeds or a pairing changes. */
export function resetConnectedPcWakeOutage(pcId?: string): void {
  if (pcId) requestedForOutage.delete(pcId);
  else requestedForOutage.clear();
}

/**
 * POST the stored wake capability once for this PC's current outage.
 *
 * A failed POST still consumes the outage attempt. Retrying an authenticated
 * capability in a tight health loop would waste battery and could wake the Mac
 * repeatedly if the response was lost after the server accepted it.
 */
export async function requestConnectedPcWakeOnce(
  deps: RequestConnectedPcWakeDeps = {}
): Promise<WakeRequestResult> {
  const pcId = await (deps.getPcId ?? getConnectedPcId)();
  if (!pcId) return 'unavailable';
  if (requestedForOutage.has(pcId)) return 'already-requested';

  const capability = await (deps.getCapability ?? getWakeCapability)(pcId);
  if (!capability) return 'unavailable';

  // Latch before starting I/O so concurrent health and socket failures cannot
  // race into duplicate POSTs.
  requestedForOutage.add(pcId);
  deps.onRequest?.();

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const signal = (deps.timeoutSignal ?? defaultTimeoutSignal)(WAKE_REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(capability.wakeUrl, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${capability.wakeToken}`,
      },
      ...(signal ? { signal } : {}),
    });
    return response.ok ? 'requested' : 'failed';
  } catch {
    return 'failed';
  }
}

/** True when a wake-capable outage should receive the longer health retry budget. */
export function wakeRequestExtendsRetry(result: WakeRequestResult): boolean {
  return result !== 'unavailable';
}
