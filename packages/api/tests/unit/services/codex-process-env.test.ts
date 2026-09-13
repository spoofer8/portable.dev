import { describe, expect, test } from 'bun:test';

import { buildCodexProcessEnv } from '../../../src/services/CodexService/processEnv.js';

describe('buildCodexProcessEnv', () => {
  test('passes runtime and Codex provider variables without leaking Portable or unrelated secrets', () => {
    const env = buildCodexProcessEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/test',
        OPENAI_API_KEY: 'openai',
        CLIPROXY_API_KEY: 'cliproxy',
        AZURE_API_KEY: 'azure',
        PORTABLE_E2E_PSK: 'portable-secret',
        JWT_SECRET: 'jwt-secret',
        GITHUB_TOKEN: 'github-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
        CUSTOM_CODEX_TOKEN: 'custom',
        UNRELATED_SECRET: 'unrelated',
      },
      ['CUSTOM_CODEX_TOKEN']
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      OPENAI_API_KEY: 'openai',
      CLIPROXY_API_KEY: 'cliproxy',
      AZURE_API_KEY: 'azure',
      CUSTOM_CODEX_TOKEN: 'custom',
    });
  });

  test('never allows an operator override to re-enable explicitly denied credentials', () => {
    const env = buildCodexProcessEnv(
      {
        JWT_SECRET: 'jwt',
        SESSION_SECRET: 'session',
        SERVICE_TOKEN: 'service',
        GITHUB_TOKEN: 'github',
        GITHUB_OAUTH_TOKEN: 'github-oauth',
        ANTHROPIC_API_KEY: 'anthropic',
        ANTHROPIC_BASE_URL: 'anthropic-url',
        PORTABLE_E2E_PSK: 'e2e',
        SESSION_HOOK_TOKEN: 'hook',
      },
      [
        'JWT_SECRET',
        'SESSION_SECRET',
        'SERVICE_TOKEN',
        'GITHUB_TOKEN',
        'GITHUB_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'PORTABLE_E2E_PSK',
        'SESSION_HOOK_TOKEN',
      ]
    );
    expect(env).toEqual({});
  });

  test('reads the operator allowlist without forwarding the control variable itself', () => {
    const env = buildCodexProcessEnv({
      PORTABLE_CODEX_ENV_ALLOWLIST: 'CUSTOM_ONE, CUSTOM_TWO',
      CUSTOM_ONE: 'one',
      CUSTOM_TWO: 'two',
    });
    expect(env).toEqual({ CUSTOM_ONE: 'one', CUSTOM_TWO: 'two' });
  });
});
