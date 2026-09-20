import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import { StdioCodexTransport } from '../../api/src/services/CodexService/CodexAppServerClient.js';
import { buildApiChildEnv } from '../src/config.js';
import {
  SERVICE_CODEX_ENV_SECRET_KEY,
  SERVICE_CODEX_ENV_STORE_DIRECTORY,
  captureServiceCodexEnvironment,
  deleteServiceCodexEnvironment,
  restoreServiceCodexEnvironment,
} from '../src/ServiceCodexEnvironment.js';
import { runServiceCommand } from '../src/ServiceCommands.js';

import type { ServiceManager } from '../src/ServiceManager.js';

describe('service Codex environment', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  function store(): LocalSecretStore {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-codex-env-'));
    return new LocalSecretStore({ dataDir: tmpDir });
  }

  it('captures an allowlisted snapshot encrypted at rest and replaces removed keys', () => {
    const secrets = store();
    captureServiceCodexEnvironment({
      store: secrets,
      env: {
        AZURE_API_KEY: 'azure-value',
        CLIPROXY_API_KEY: 'cliproxy-value',
        PORTABLE_CODEX_ENV_ALLOWLIST: 'CUSTOM_PROVIDER_KEY',
        CUSTOM_PROVIDER_KEY: 'custom-value',
        JWT_SECRET: 'must-not-persist',
      },
    });

    expect(secrets.has(SERVICE_CODEX_ENV_SECRET_KEY)).toBe(true);
    const disk = fs.readFileSync(path.join(tmpDir, 'secrets.json'), 'utf8');
    expect(disk).not.toContain('azure-value');
    expect(disk).not.toContain('cliproxy-value');
    expect(disk).not.toContain('custom-value');
    expect(disk).not.toContain('must-not-persist');

    captureServiceCodexEnvironment({ store: secrets, env: { AZURE_API_KEY: 'new-azure' } });
    const restored: NodeJS.ProcessEnv = {};
    expect(restoreServiceCodexEnvironment({ store: secrets, env: restored })).toBe('restored');
    expect(restored).toEqual({ AZURE_API_KEY: 'new-azure' });
  });

  it('uses a dedicated encrypted store instead of the main credential store by default', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-codex-env-root-'));
    captureServiceCodexEnvironment({
      env: { PORTABLE_DATA_DIR: tmpDir, AZURE_API_KEY: 'dedicated-azure' },
    });

    expect(fs.existsSync(path.join(tmpDir, 'secrets.json'))).toBe(false);
    const snapshotPath = path.join(tmpDir, SERVICE_CODEX_ENV_STORE_DIRECTORY, 'secrets.json');
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.readFileSync(snapshotPath, 'utf8')).not.toContain('dedicated-azure');
  });

  it('restores only missing values and preserves the stored custom allowlist for Codex', () => {
    const secrets = store();
    captureServiceCodexEnvironment({
      store: secrets,
      env: {
        AZURE_API_KEY: 'stored-azure',
        PORTABLE_CODEX_ENV_ALLOWLIST: 'CUSTOM_PROVIDER_KEY',
        CUSTOM_PROVIDER_KEY: 'stored-custom',
      },
    });
    const serviceEnv: NodeJS.ProcessEnv = { AZURE_API_KEY: 'ambient-azure' };

    restoreServiceCodexEnvironment({ store: secrets, env: serviceEnv });

    expect(serviceEnv.AZURE_API_KEY).toBe('ambient-azure');
    expect(serviceEnv.CUSTOM_PROVIDER_KEY).toBe('stored-custom');
    expect(serviceEnv.PORTABLE_CODEX_ENV_ALLOWLIST).toBe('CUSTOM_PROVIDER_KEY');
  });

  it('uses an ambient custom allowlist instead of reviving a removed stored entry', () => {
    const secrets = store();
    captureServiceCodexEnvironment({
      store: secrets,
      env: {
        AZURE_API_KEY: 'stored-azure',
        PORTABLE_CODEX_ENV_ALLOWLIST: 'OLD_PROVIDER_KEY',
        OLD_PROVIDER_KEY: 'old-provider',
      },
    });
    const serviceEnv: NodeJS.ProcessEnv = {
      PORTABLE_CODEX_ENV_ALLOWLIST: 'NEW_PROVIDER_KEY',
      NEW_PROVIDER_KEY: 'ambient-provider',
    };

    restoreServiceCodexEnvironment({ store: secrets, env: serviceEnv });

    expect(serviceEnv.AZURE_API_KEY).toBe('stored-azure');
    expect(serviceEnv.OLD_PROVIDER_KEY).toBeUndefined();
    expect(serviceEnv.NEW_PROVIDER_KEY).toBe('ambient-provider');
    expect(serviceEnv.PORTABLE_CODEX_ENV_ALLOWLIST).toBe('NEW_PROVIDER_KEY');
  });

  it('fails closed on malformed or unreadable snapshots without logging values', () => {
    const leaked = 'do-not-log-this-value';
    const logs: string[] = [];
    const malformedStore = {
      get: () =>
        JSON.stringify({ version: 1, allowlist: ['JWT_SECRET'], env: { JWT_SECRET: leaked } }),
      set: () => {},
      delete: () => false,
    };
    const target: NodeJS.ProcessEnv = {};
    expect(
      restoreServiceCodexEnvironment({
        store: malformedStore,
        env: target,
        log: (line) => logs.push(line),
      })
    ).toBe('invalid');
    expect(target).toEqual({});
    expect(logs.join('\n')).not.toContain(leaked);

    const corruptLogs: string[] = [];
    expect(
      restoreServiceCodexEnvironment({
        store: {
          ...malformedStore,
          get: () => {
            throw new Error(`decrypt failed near ${leaked}`);
          },
        },
        env: {},
        log: (line) => corruptLogs.push(line),
      })
    ).toBe('invalid');
    expect(corruptLogs.join('\n')).not.toContain(leaked);
  });

  it('deletes only the service Codex snapshot', () => {
    const secrets = store();
    secrets.set('launcher:jwt-secret', 'keep-me');
    captureServiceCodexEnvironment({ store: secrets, env: { AZURE_API_KEY: 'azure' } });

    expect(deleteServiceCodexEnvironment({ store: secrets })).toBe(true);
    expect(secrets.has(SERVICE_CODEX_ENV_SECRET_KEY)).toBe(false);
    expect(secrets.get('launcher:jwt-secret')).toBe('keep-me');
  });

  it('carries install-shell provider keys through service restore, API env, and Codex env', async () => {
    const secrets = store();
    const installEnv: NodeJS.ProcessEnv = {
      AZURE_API_KEY: 'azure-chain',
      CLIPROXY_API_KEY: 'cliproxy-chain',
    };
    const order: string[] = [];
    const manager: ServiceManager = {
      install: async () => void order.push('manager-install'),
      uninstall: async () => {},
      start: async () => {},
      stop: async () => {},
      status: async () => ({ installed: true, enabled: true, active: true, runtimeHealthy: true }),
    };

    const code = await runServiceCommand(['service', 'install'], {
      platform: 'darwin',
      makeManager: () => manager,
      out: () => {},
      persistManifest: () => {},
      clearInstallArtifacts: () => {},
      captureCodexEnvironment: () => {
        order.push('capture');
        captureServiceCodexEnvironment({ store: secrets, env: installEnv });
      },
    });
    expect(code).toBe(0);
    expect(order).toEqual(['capture', 'manager-install']);

    const serviceEnv: NodeJS.ProcessEnv = {};
    expect(restoreServiceCodexEnvironment({ store: secrets, env: serviceEnv })).toBe('restored');
    const apiEnv = buildApiChildEnv(serviceEnv);
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 0,
      signalCode: null,
      kill: () => true,
    });
    const transport = new StdioCodexTransport(
      { command: 'codex', env: apiEnv },
      (_command, _args, options) => {
        spawnedEnv = options.env;
        return child as never;
      }
    );
    transport.start({
      onLine: () => {},
      onStderr: () => {},
      onExit: () => {},
      onError: () => {},
    });

    expect(spawnedEnv).toMatchObject({
      AZURE_API_KEY: 'azure-chain',
      CLIPROXY_API_KEY: 'cliproxy-chain',
    });
    expect(spawnedEnv?.JWT_SECRET).toBeUndefined();
  });
});
