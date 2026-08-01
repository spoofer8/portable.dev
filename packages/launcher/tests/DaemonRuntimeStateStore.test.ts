/**
 * DaemonRuntimeStateStore tests (PRD §7) — the daemon's structured runtime state
 * file. Verifies atomic/restrictive writes, milestone patching with a seed,
 * version/corruption safety, and that it never persists an unexpected field.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DAEMON_RUNTIME_STATE_SCHEMA_VERSION,
  DaemonRuntimeStateStore,
  type DaemonRuntimeState,
} from '../src/DaemonRuntimeStateStore.js';

let tmpDir = '';
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});
function freshDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-state-'));
  return tmpDir;
}

const FULL: DaemonRuntimeState = {
  schemaVersion: DAEMON_RUNTIME_STATE_SCHEMA_VERSION,
  mode: 'service',
  phase: 'healthy',
  pid: 4242,
  startedAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:00:00.000Z',
  endpoint: 'https://relay.example/t/pc_abc',
  apiHealthy: true,
  tunnelProvider: 'cloudflare',
  tunnelHealthy: true,
  publicTunnelUrl: 'https://foo.trycloudflare.com',
  relayRegistered: true,
  lastRegisteredAt: '2026-07-23T10:00:01.000Z',
};

describe('DaemonRuntimeStateStore', () => {
  it('writes atomically with 0600 perms and round-trips', () => {
    const dir = freshDir();
    const store = new DaemonRuntimeStateStore({
      dataDir: dir,
      now: () => new Date('2026-07-23T11:00:00.000Z'),
    });
    const written = store.write(FULL);
    // updatedAt is stamped at write time.
    expect(written.updatedAt).toBe('2026-07-23T11:00:00.000Z');
    expect(fs.existsSync(`${store.filePath}.tmp`)).toBe(false);
    expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600);
    expect(store.read()).toEqual({ ...FULL, updatedAt: '2026-07-23T11:00:00.000Z' });
  });

  it('read returns null for missing, corrupt, and unknown-version files', () => {
    const dir = freshDir();
    const store = new DaemonRuntimeStateStore({ dataDir: dir });
    expect(store.read()).toBeNull(); // missing
    fs.writeFileSync(store.filePath, 'not json{{');
    expect(store.read()).toBeNull(); // corrupt
    fs.writeFileSync(store.filePath, JSON.stringify({ ...FULL, schemaVersion: 999 }));
    expect(store.read()).toBeNull(); // unknown version
  });

  it('patch seeds immutable fields on first write and carries them forward', () => {
    const dir = freshDir();
    let clock = 0;
    const store = new DaemonRuntimeStateStore({
      dataDir: dir,
      now: () => new Date(1_000_000 + clock++ * 1000),
    });
    const first = store.patch(
      { phase: 'starting', apiHealthy: false },
      {
        pid: 777,
        startedAt: '2026-07-23T09:00:00.000Z',
        endpoint: 'https://relay.example/t/pc_x',
        tunnelProvider: 'ngrok',
      }
    );
    expect(first.pid).toBe(777);
    expect(first.endpoint).toBe('https://relay.example/t/pc_x');
    expect(first.tunnelProvider).toBe('ngrok');

    // A later patch (no seed) keeps the seeded immutable fields.
    const second = store.patch({ phase: 'healthy', apiHealthy: true });
    expect(second.pid).toBe(777);
    expect(second.startedAt).toBe('2026-07-23T09:00:00.000Z');
    expect(second.tunnelProvider).toBe('ngrok');
    expect(second.phase).toBe('healthy');
    expect(second.apiHealthy).toBe(true);
  });

  it('never persists an unexpected (potentially secret) field', () => {
    const dir = freshDir();
    const store = new DaemonRuntimeStateStore({ dataDir: dir });
    store.write({
      ...FULL,
      // A sneaked-in secret must be dropped by the key whitelist.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ token: 'LEAKED-JWT', e2eKey: 'LEAKED-PSK' } as any),
    });
    const raw = fs.readFileSync(store.filePath, 'utf8');
    expect(raw).not.toContain('LEAKED-JWT');
    expect(raw).not.toContain('LEAKED-PSK');
  });

  it('clear removes the file and never throws when absent', () => {
    const dir = freshDir();
    const store = new DaemonRuntimeStateStore({ dataDir: dir });
    store.write(FULL);
    expect(fs.existsSync(store.filePath)).toBe(true);
    store.clear();
    expect(fs.existsSync(store.filePath)).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });
});
