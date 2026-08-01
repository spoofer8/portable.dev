/**
 * ServiceInstallManifest tests (PRD §5, §12.2) — the cwd-independent record of
 * how the daemon was installed. Verifies it captures the effective install
 * context, round-trips atomically with restrictive perms, contains NO secret,
 * and rejects an incompatible schema version with reinstall guidance.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  SERVICE_MANIFEST_SCHEMA_VERSION,
  ServiceManifestVersionError,
  buildServiceInstallManifest,
  defaultServiceManifestPath,
  readServiceInstallManifest,
  removeServiceInstallManifest,
  writeServiceInstallManifest,
  type ServiceInstallManifest,
} from '../src/ServiceInstallManifest.js';

/** A minimal in-memory LocalSecretStore stand-in (only get/set are used). */
function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: (k: string) => map.get(k),
    set: (k: string, v: string) => {
      map.set(k, v);
    },
    _map: map,
  };
}

const BASE_ENV: NodeJS.ProcessEnv = {
  PORTABLE_PC_ID: 'pc_abc123',
  PORTABLE_PC_LABEL: 'work-mini',
  PORTABLE_RELAY_URL: 'https://relay.example',
  VGIT_PORT: '4300',
  PORTABLE_TUNNEL_PROVIDER: 'ngrok',
  // Secrets that must NEVER end up in the manifest (§5/§12.2).
  JWT_SECRET: 'super-secret-jwt-value-do-not-leak',
  PORTABLE_E2E_PSK: 'e2e-psk-base64-do-not-leak',
};

describe('buildServiceInstallManifest', () => {
  it('freezes the effective install context from env/store/cwd', () => {
    const m = buildServiceInstallManifest({
      store: fakeStore(),
      env: BASE_ENV,
      cwd: '/home/u/projects/app',
      forwardedFlags: ['--dev', '--ngrok'],
      platform: 'linux',
      now: new Date('2026-07-23T10:00:00.000Z'),
      cliVersion: '3.5.2',
      dataDir: '/home/u/.portable',
    });
    expect(m).toEqual({
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      installedAt: '2026-07-23T10:00:00.000Z',
      cliVersion: '3.5.2',
      platform: 'linux',
      workingDirectory: '/home/u/projects/app',
      dataDir: '/home/u/.portable',
      pcId: 'pc_abc123',
      pcLabel: 'work-mini',
      relayBaseUrl: 'https://relay.example',
      apiPort: 4300,
      tunnelProvider: 'ngrok',
      forwardedFlags: ['--dev', '--ngrok'],
    });
  });

  it('persists a generated pcId into the store when env has none', () => {
    const store = fakeStore();
    const m = buildServiceInstallManifest({
      store,
      env: { ...BASE_ENV, PORTABLE_PC_ID: undefined },
      cwd: '/x',
      dataDir: '/x/.portable',
    });
    expect(m.pcId).toMatch(/^pc_/);
    // The same id was persisted for the daemon to reuse (TunnelRegistrationAgent.PC_ID_KEY).
    expect(store.get('tunnel:pc-id')).toBe(m.pcId);
  });

  it('NEVER contains a JWT secret, E2E PSK, or any token (§5/§12.2)', () => {
    const m = buildServiceInstallManifest({
      store: fakeStore({
        'launcher:jwt-secret': 'stored-secret',
        'launcher:e2e-psk': 'stored-psk',
      }),
      env: BASE_ENV,
      cwd: '/x',
      dataDir: '/x/.portable',
    });
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain('super-secret-jwt-value-do-not-leak');
    expect(serialized).not.toContain('e2e-psk-base64-do-not-leak');
    expect(serialized).not.toContain('stored-secret');
    expect(serialized).not.toContain('stored-psk');
  });
});

describe('write/read round-trip', () => {
  const manifest: ServiceInstallManifest = {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    installedAt: '2026-07-23T10:00:00.000Z',
    cliVersion: '3.5.2',
    platform: 'darwin',
    workingDirectory: '/Users/u/app',
    dataDir: '/Users/u/.portable',
    pcId: 'pc_abc123',
    pcLabel: 'work-mini',
    relayBaseUrl: 'https://relay.example',
    apiPort: 4300,
    tunnelProvider: 'cloudflare',
    forwardedFlags: [],
  };

  it('round-trips through injected seams', () => {
    const files = new Map<string, string>();
    writeServiceInstallManifest(manifest, {
      manifestPath: '/tmp/m.json',
      writeImpl: (p, c) => files.set(p, c),
    });
    const read = readServiceInstallManifest('/ignored', {
      manifestPath: '/tmp/m.json',
      readImpl: (p) =>
        files.get(p) ??
        (() => {
          throw new Error('ENOENT');
        })(),
    });
    expect(read).toEqual(manifest);
  });

  it('writes atomically to <dataDir>/service-install.json with 0600 perms', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-manifest-'));
    try {
      const withDir = { ...manifest, dataDir: dir };
      writeServiceInstallManifest(withDir);
      const target = defaultServiceManifestPath(dir);
      expect(fs.existsSync(target)).toBe(true);
      // No leftover tmp file (atomic rename completed).
      expect(fs.existsSync(`${target}.tmp`)).toBe(false);
      // Restrictive perms (§5) — owner read/write only.
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(readServiceInstallManifest(dir)).toEqual(withDir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readServiceInstallManifest', () => {
  it('returns null when the manifest is absent', () => {
    expect(
      readServiceInstallManifest('/ignored', {
        manifestPath: '/nope.json',
        readImpl: () => {
          throw new Error('ENOENT');
        },
      })
    ).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    expect(
      readServiceInstallManifest('/ignored', {
        manifestPath: '/m.json',
        readImpl: () => 'not json{{',
      })
    ).toBeNull();
  });

  it('throws ServiceManifestVersionError on an incompatible schema (reinstall guidance)', () => {
    const stale = JSON.stringify({
      schemaVersion: 999,
      pcId: 'pc_x',
      dataDir: '/d',
      relayBaseUrl: 'r',
      apiPort: 1,
    });
    expect(() =>
      readServiceInstallManifest('/ignored', { manifestPath: '/m.json', readImpl: () => stale })
    ).toThrow(ServiceManifestVersionError);
    try {
      readServiceInstallManifest('/ignored', { manifestPath: '/m.json', readImpl: () => stale });
    } catch (err) {
      expect((err as Error).message).toContain('Reinstall');
      expect((err as ServiceManifestVersionError).foundVersion).toBe(999);
    }
  });

  it('returns null when required routing fields are missing', () => {
    const partial = JSON.stringify({
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      pcId: 'pc_x',
    });
    expect(
      readServiceInstallManifest('/ignored', { manifestPath: '/m.json', readImpl: () => partial })
    ).toBeNull();
  });
});

describe('removeServiceInstallManifest', () => {
  it('removes the manifest and never throws on a missing file', () => {
    const removed: string[] = [];
    removeServiceInstallManifest('/home/u/.portable', (p) => removed.push(p));
    expect(removed).toEqual([defaultServiceManifestPath('/home/u/.portable')]);
    // A throwing remove impl is swallowed.
    expect(() =>
      removeServiceInstallManifest('/d', () => {
        throw new Error('boom');
      })
    ).not.toThrow();
  });
});
