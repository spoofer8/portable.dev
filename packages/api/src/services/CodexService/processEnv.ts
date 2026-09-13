const BASE_ALLOWED_KEYS = new Set([
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
]);

const DENIED_KEYS = new Set([
  'JWT_SECRET',
  'SESSION_SECRET',
  'SERVICE_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

const isDenied = (key: string): boolean =>
  DENIED_KEYS.has(key) ||
  key.startsWith('PORTABLE_') ||
  key.startsWith('CLAUDE_') ||
  key.startsWith('ANTHROPIC_') ||
  key.startsWith('GITHUB_') ||
  (/HOOK/i.test(key) && /(KEY|SECRET|TOKEN)/i.test(key)) ||
  (/E2E/i.test(key) && /(KEY|PSK|SECRET|TOKEN)/i.test(key));

/** Builds the minimal environment inherited by a Codex app-server child. */
export const buildCodexProcessEnv = (
  source: NodeJS.ProcessEnv = process.env,
  extraAllowedKeys?: readonly string[]
): NodeJS.ProcessEnv => {
  const operatorAllowlist =
    extraAllowedKeys ??
    (source.PORTABLE_CODEX_ENV_ALLOWLIST ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
  const allowed = new Set([...BASE_ALLOWED_KEYS, ...operatorAllowlist]);
  const result: NodeJS.ProcessEnv = {};

  for (const key of allowed) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isDenied(key)) continue;
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && typeof value === 'string') result[key] = value;
  }
  return result;
};
