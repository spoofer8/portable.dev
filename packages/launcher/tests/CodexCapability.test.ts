import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_CODEX_PRESETS,
  discoverCodexCapability,
  formatCodexCapabilityGuidance,
  resolveCodexCandidates,
  resolveCodexPresetsJson,
} from '../src/CodexCapability.js';

describe('Codex capability discovery', () => {
  it('detects an explicit Codex executable and reports its version', async () => {
    const probes: string[] = [];
    const result = await discoverCodexCapability({
      env: { CODEX_BIN: '/opt/codex/bin/codex' },
      platform: 'darwin',
      accessImpl: () => true,
      probeVersion: async (command) => {
        probes.push(command);
        return 'codex-cli 0.98.0';
      },
    });

    expect(result).toEqual({
      available: true,
      command: '/opt/codex/bin/codex',
      version: 'codex-cli 0.98.0',
    });
    expect(probes).toEqual(['/opt/codex/bin/codex']);
  });

  it('finds Codex on PATH without probing shell aliases', async () => {
    const probes: string[] = [];
    const candidates = resolveCodexCandidates(
      { PATH: '/usr/bin:/opt/homebrew/bin' },
      'darwin',
      () => '/Users/me',
      (candidate) => candidate === '/opt/homebrew/bin/codex'
    );

    const result = await discoverCodexCapability({
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      platform: 'darwin',
      homedir: () => '/Users/me',
      accessImpl: (candidate) => candidate === '/opt/homebrew/bin/codex',
      probeVersion: async (command) => {
        probes.push(command);
        return 'codex-cli 0.98.0';
      },
    });

    expect(candidates).toContain('/opt/homebrew/bin/codex');
    expect(candidates).not.toContain('supersol');
    expect(candidates).not.toContain('superastra');
    expect(probes).toEqual(['/opt/homebrew/bin/codex']);
    expect(result.available).toBe(true);
  });

  it('ignores shell alias names in CODEX_BIN and probes the native executable instead', async () => {
    const probes: string[] = [];
    const result = await discoverCodexCapability({
      env: { CODEX_BIN: 'supersol', PATH: '/opt/homebrew/bin' },
      platform: 'darwin',
      accessImpl: (candidate) => candidate === '/opt/homebrew/bin/codex',
      probeVersion: async (command) => {
        probes.push(command);
        return 'codex-cli 0.98.0';
      },
    });

    expect(result).toEqual({
      available: true,
      command: '/opt/homebrew/bin/codex',
      version: 'codex-cli 0.98.0',
    });
    expect(probes).toEqual(['/opt/homebrew/bin/codex']);
  });

  it('returns an optional missing capability when Codex is absent', async () => {
    const result = await discoverCodexCapability({
      env: { PATH: '/usr/bin' },
      platform: 'darwin',
      homedir: () => '/Users/me',
      accessImpl: () => false,
      probeVersion: async () => {
        throw new Error('must not probe missing paths');
      },
    });

    expect(result).toEqual({ available: false });
  });

  it('continues after a version probe fails and never throws', async () => {
    const result = await discoverCodexCapability({
      env: { PATH: '/first:/second' },
      platform: 'darwin',
      accessImpl: () => true,
      probeVersion: async (command) => {
        if (command === '/first/codex') throw new Error('broken executable');
        return command === '/second/codex' ? 'codex-cli 0.98.0\n' : null;
      },
    });

    expect(result).toEqual({
      available: true,
      command: '/second/codex',
      version: 'codex-cli 0.98.0',
    });
  });

  it('provides actionable guidance without exposing environment values', () => {
    expect(
      formatCodexCapabilityGuidance({
        available: true,
        command: '/opt/homebrew/bin/codex',
        version: 'codex-cli 0.98.0',
      })
    ).toEqual([
      '[launcher] ✓ Codex ready: /opt/homebrew/bin/codex (codex-cli 0.98.0); presets: supersol, superastra',
    ]);
    expect(formatCodexCapabilityGuidance({ available: false })).toEqual([
      '[launcher] Codex CLI not found; continuing with Claude support.',
      '[launcher]   Install Codex with `npm install -g @openai/codex`, then restart Portable.',
    ]);
  });
});

describe('Codex preset mapping', () => {
  it('represents the supersol and superastra aliases as app-server configuration', () => {
    expect(DEFAULT_CODEX_PRESETS).toEqual({
      supersol: {
        model: 'gpt-5.6-sol',
        modelProvider: 'cliproxy',
        sandbox: 'workspace-write',
        effort: 'ultra',
        config: {
          model_context_window: 1_050_000,
          model_auto_compact_token_limit: 900_000,
        },
      },
      superastra: {
        model: 'gpt-6-astra',
        modelProvider: 'cliproxy',
        sandbox: 'workspace-write',
        effort: 'ultra',
        config: {
          model_context_window: 1_050_000,
          model_auto_compact_token_limit: 900_000,
        },
      },
    });
  });

  it('preserves an operator-provided preset mapping verbatim', () => {
    const configured = '{"private-provider":{"model":"custom"}}';
    expect(resolveCodexPresetsJson({ CODEX_PRESETS_JSON: configured })).toBe(configured);
  });

  it('serializes the safe built-in preset mapping when none is configured', () => {
    expect(JSON.parse(resolveCodexPresetsJson({}))).toEqual(DEFAULT_CODEX_PRESETS);
  });
});
