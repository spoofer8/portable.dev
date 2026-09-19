/**
 * socketLog — lightweight observability for the Socket.IO lifecycle.
 *
 * Funnels every step (build → E2E handshake → connect / disconnect / connect_error)
 * to (1) the JS console — visible in Metro / Xcode / logcat on a dev build — and
 * (2) a Sentry breadcrumb, so a release/TestFlight report carries the same trail.
 * Grep the device log for `[socket]` to follow a single connection attempt. Never
 * throws (Sentry may be uninitialized in a plain `expo start` with no DSN).
 */
import * as Sentry from '@sentry/react-native';

import { redactSentryText, sanitizeSentryAttributes } from '@/features/observability/sentryConfig';

export type SocketLogLevel = 'info' | 'warning' | 'error';

/** Keep diagnostics in development, but never place connection metadata in release device logs. */
const IS_TEST = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
const SHOULD_LOG_TO_CONSOLE = __DEV__ && !IS_TEST;

export function socketLog(
  event: string,
  data?: Record<string, unknown>,
  level: SocketLogLevel = 'info'
): void {
  const safeEvent = redactSentryText(event);
  const tag = `[socket] ${safeEvent}`;
  const sentryData = sanitizeSentryAttributes(data);
  // Console — the primary channel while debugging a dev build (Metro / Xcode /
  // logcat). It receives the same sanitized fields as Sentry and is disabled in release.
  if (SHOULD_LOG_TO_CONSOLE) {
    if (level === 'error') console.error(tag, sentryData ?? '');
    else if (level === 'warning') console.warn(tag, sentryData ?? '');
    else console.log(tag, sentryData ?? '');
  }
  try {
    Sentry.addBreadcrumb({ category: 'socket', message: safeEvent, level, data: sentryData });
    if (level === 'error') Sentry.logger.error(tag, sentryData);
    else if (level === 'warning') Sentry.logger.warn(tag, sentryData);
    else Sentry.logger.info(tag, sentryData);
  } catch {
    // Sentry not initialized (plain `expo start` with no DSN) — the console suffices.
  }
}

/** Redact an id/token to a short, non-sensitive prefix for logs (never log the whole thing). */
export function shortId(id: string | null | undefined): string {
  if (!id) return 'none';
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}
