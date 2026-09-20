const BASE_CODEX_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'SSH_AUTH_SOCK',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLIPROXY_API_KEY',
  'AZURE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
] as const;

const DENIED_CODEX_ENV_KEYS = new Set([
  'JWT_SECRET',
  'SESSION_SECRET',
  'SERVICE_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Credentials and Portable internals that must never reach a Codex child. */
export function isCodexEnvDenied(key: string): boolean {
  return (
    DENIED_CODEX_ENV_KEYS.has(key) ||
    key.startsWith('PORTABLE_') ||
    key.startsWith('CLAUDE_') ||
    key.startsWith('ANTHROPIC_') ||
    key.startsWith('GITHUB_') ||
    (/HOOK/i.test(key) && /(KEY|SECRET|TOKEN)/i.test(key)) ||
    (/E2E/i.test(key) && /(KEY|PSK|SECRET|TOKEN)/i.test(key))
  );
}

/** Parse the operator extension without allowing invalid or denied names through. */
export function parseCodexEnvAllowlist(value: string | readonly string[] | undefined): string[] {
  const entries: readonly string[] = typeof value === 'string' ? value.split(',') : (value ?? []);
  return [
    ...new Set(
      entries.map((key) => key.trim()).filter((key) => ENV_NAME.test(key) && !isCodexEnvDenied(key))
    ),
  ];
}

/**
 * Select the environment a Codex app-server child may inherit.
 *
 * Passing `extraAllowedKeys` preserves the original `buildCodexProcessEnv` API:
 * an explicit list replaces the control variable, while `undefined` reads
 * `PORTABLE_CODEX_ENV_ALLOWLIST` from `source`.
 */
export function selectCodexProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
  extraAllowedKeys?: readonly string[]
): Record<string, string> {
  const operatorAllowlist = parseCodexEnvAllowlist(
    extraAllowedKeys ?? source.PORTABLE_CODEX_ENV_ALLOWLIST
  );
  const allowed = new Set<string>([...BASE_CODEX_ENV_KEYS, ...operatorAllowlist]);
  const result: Record<string, string> = {};

  for (const key of allowed) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && ENV_NAME.test(key) && typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

/** True when a key is eligible under the built-in and supplied operator policy. */
export function isCodexEnvAllowed(key: string, operatorAllowlist: readonly string[] = []): boolean {
  if (!ENV_NAME.test(key) || isCodexEnvDenied(key)) return false;
  return (
    (BASE_CODEX_ENV_KEYS as readonly string[]).includes(key) ||
    key.startsWith('LC_') ||
    parseCodexEnvAllowlist(operatorAllowlist).includes(key)
  );
}
