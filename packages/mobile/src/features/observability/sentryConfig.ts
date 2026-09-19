/**
 * Sentry runtime configuration resolution for the native RN app.
 *
 * Framework-free (NO `@sentry/*` import) so it stays unit-testable and out of the
 * native-module graph. Uses this package's `EXPO_PUBLIC_*` env convention (the
 * `gatewayConfig` pattern: a pure resolver + an env reader, never mutate
 * `process.env` in tests — babel-preset-expo inlines `EXPO_PUBLIC_*`).
 */

/** Env snapshot consumed by the pure resolvers (injectable for tests). */
export interface SentryEnv {
  /** `EXPO_PUBLIC_SENTRY_DSN` — CI override; always wins when set. */
  dsn?: string;
  /** `EXPO_PUBLIC_ENABLE_SENTRY_TEST === 'true'` — turn Sentry on in a dev build. */
  enableTest: boolean;
  /** `EXPO_PUBLIC_SENTRY_ENVIRONMENT` — explicit environment override (else `Platform.OS`). */
  environment?: string;
}

const SAFE_LOG_ATTRIBUTES = new Set([
  'attempt',
  'attempts',
  'code',
  'connected',
  'e2eConfigured',
  'encrypted',
  'environment',
  'hasToken',
  'level',
  'platform',
  'reason',
  'reconnect',
  'service',
  'state',
  'status',
  'transport',
]);

export function redactSentryText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*["']?[^,\s"']+/gi,
      '$1=[redacted]'
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\/(?:Users|home|private|var)\/\S+/g, '[path]')
    .slice(0, 256);
}

export function sanitizeSentryAttributes(
  attributes: Record<string, unknown> | undefined
): Record<string, string | number | boolean> | undefined {
  if (!attributes) return undefined;

  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!SAFE_LOG_ATTRIBUTES.has(key)) continue;
    if (typeof value === 'string') sanitized[key] = redactSentryText(value);
    else if (typeof value === 'number' || typeof value === 'boolean') sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Read the specific `EXPO_PUBLIC_*` keys DIRECTLY so babel-preset-expo can inline
 * them at build time. The pure resolvers below accept an injected `SentryEnv` so
 * tests never touch `process.env`.
 */
export function readSentryEnv(): SentryEnv {
  return {
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    enableTest: process.env.EXPO_PUBLIC_ENABLE_SENTRY_TEST === 'true',
    environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT,
  };
}

/** Whether this build opted into Sentry-test mode. */
export function isSentryTestEnabled(env: SentryEnv = readSentryEnv()): boolean {
  return env.enableTest;
}

/**
 * Resolve which DSN (if any) the runtime SDK initializes with — the pure core.
 *
 * `EXPO_PUBLIC_SENTRY_DSN` is required in every build that should report errors.
 * Keeping the DSN out of the repository prevents forks and local builds from
 * sending events to somebody else's project. Builds without the variable skip
 * Sentry entirely.
 */
export function resolveSentryDsn(
  _dev: boolean,
  env: SentryEnv = readSentryEnv()
): string | undefined {
  if (env.dsn && env.dsn.trim() !== '') return env.dsn;
  return undefined;
}

/** DSN for the current build (consults the live `__DEV__` + env). */
export function getSentryDsn(): string | undefined {
  return resolveSentryDsn(__DEV__);
}

/** Explicit Sentry environment override, if the build set one. */
export function getSentryEnvironment(env: SentryEnv = readSentryEnv()): string | undefined {
  return env.environment;
}
