import { describe, expect, test } from 'bun:test';

import { parseCodexEnvAllowlist, selectCodexProcessEnv } from '../src/codexEnv.js';

describe('selectCodexProcessEnv', () => {
  test('selects the built-in provider environment and valid operator additions', () => {
    expect(
      selectCodexProcessEnv({
        AZURE_API_KEY: 'azure',
        CLIPROXY_API_KEY: 'cliproxy',
        PORTABLE_CODEX_ENV_ALLOWLIST: 'CUSTOM_PROVIDER_TOKEN, invalid-name',
        CUSTOM_PROVIDER_TOKEN: 'custom',
        UNRELATED_SECRET: 'unrelated',
      })
    ).toEqual({
      AZURE_API_KEY: 'azure',
      CLIPROXY_API_KEY: 'cliproxy',
      CUSTOM_PROVIDER_TOKEN: 'custom',
    });
  });

  test('an operator allowlist cannot re-enable denied credential classes', () => {
    const source = {
      PORTABLE_CODEX_ENV_ALLOWLIST:
        'JWT_SECRET,GITHUB_TOKEN,ANTHROPIC_BASE_URL,PORTABLE_E2E_PSK,SESSION_HOOK_TOKEN',
      JWT_SECRET: 'jwt',
      GITHUB_TOKEN: 'github',
      ANTHROPIC_BASE_URL: 'anthropic',
      PORTABLE_E2E_PSK: 'e2e',
      SESSION_HOOK_TOKEN: 'hook',
    };

    expect(selectCodexProcessEnv(source)).toEqual({});
    expect(parseCodexEnvAllowlist(source.PORTABLE_CODEX_ENV_ALLOWLIST)).toEqual([]);
  });
});
