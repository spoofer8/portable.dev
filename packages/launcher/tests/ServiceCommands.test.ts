/**
 * ServiceCommands tests — the `portable service <action>` CLI dispatch: platform
 * pick (systemd on Linux, Scheduled Task on Windows, unsupported elsewhere),
 * action routing, exit codes, and the `debug` log dump/follow. Managers are
 * injected fakes; `debug` reads real files from a temp dir.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  followLogs,
  latestApiLogPath,
  runServiceCommand,
  tailFile,
  type ServiceCommandsDeps,
} from '../src/ServiceCommands.js';

import type { ServiceManager, ServiceStatus } from '../src/ServiceManager.js';

function fakeManager(
  status: ServiceStatus = { installed: true, enabled: true, active: true, runtimeHealthy: true }
) {
  const calls: string[] = [];
  const manager: ServiceManager = {
    install: async () => {
      calls.push('install');
    },
    uninstall: async () => {
      calls.push('uninstall');
    },
    start: async () => {
      calls.push('start');
    },
    stop: async () => {
      calls.push('stop');
    },
    status: async () => {
      calls.push('status');
      return status;
    },
  };
  return { manager, calls };
}

function harness(opts: { platform?: NodeJS.Platform; status?: ServiceStatus } = {}) {
  const { manager, calls } = fakeManager(opts.status);
  const out: string[] = [];
  const deps: ServiceCommandsDeps = {
    platform: opts.platform ?? 'linux',
    makeManager: () => manager,
    out: (line) => out.push(line),
    // No-op the manifest/artifact side effects so tests never touch the real DATA_DIR.
    persistManifest: () => {},
    clearInstallArtifacts: () => {},
    captureCodexEnvironment: () => {},
    clearCodexEnvironment: () => {},
  };
  return { deps, calls, out };
}

describe('runServiceCommand', () => {
  it('routes install/uninstall/start/stop to the platform manager (exit 0)', async () => {
    for (const action of ['install', 'uninstall', 'start', 'stop']) {
      const h = harness();
      const code = await runServiceCommand(['service', action], h.deps);
      expect(code).toBe(0);
      expect(h.calls).toEqual([action]);
    }
  });

  it('status prints the state and exits 0 when the daemon is running', async () => {
    const h = harness();
    const code = await runServiceCommand(['service', 'status'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('installed');
  });

  it('status exits 1 when not running', async () => {
    const h = harness({
      status: { installed: true, enabled: false, active: false, runtimeHealthy: false },
    });
    const code = await runServiceCommand(['service', 'status'], h.deps);
    expect(code).toBe(1);
  });

  it('routes restart to the manager as stop then start (exit 0)', async () => {
    const h = harness();
    h.deps.captureCodexEnvironment = () => h.calls.push('captureCodexEnvironment');
    const code = await runServiceCommand(['service', 'restart'], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual(['captureCodexEnvironment', 'stop', 'start']);
    expect(h.out.join('\n')).toContain('restarted');
  });

  it('persists the install manifest on install and clears artifacts on uninstall', async () => {
    const installed = harness();
    let persisted = 0;
    installed.deps.persistManifest = () => persisted++;
    await runServiceCommand(['service', 'install'], installed.deps);
    expect(persisted).toBe(1);

    const removed = harness();
    let cleared = 0;
    let codexCleared = 0;
    removed.deps.clearInstallArtifacts = () => cleared++;
    removed.deps.clearCodexEnvironment = () => codexCleared++;
    await runServiceCommand(['service', 'uninstall'], removed.deps);
    expect(cleared).toBe(1);
    expect(codexCleared).toBe(1);
  });

  it('refreshes the encrypted Codex env before starting an installed service', async () => {
    const h = harness();
    h.deps.captureCodexEnvironment = () => h.calls.push('captureCodexEnvironment');
    await runServiceCommand(['service', 'start'], h.deps);
    expect(h.calls).toEqual(['captureCodexEnvironment', 'start']);
  });

  it('reports uninstall cleanup failure after still clearing other artifacts', async () => {
    const h = harness();
    let artifactsCleared = 0;
    h.deps.clearCodexEnvironment = () => {
      throw new Error('must-not-be-printed');
    };
    h.deps.clearInstallArtifacts = () => artifactsCleared++;

    expect(await runServiceCommand(['service', 'uninstall'], h.deps)).toBe(1);
    expect(artifactsCleared).toBe(1);
    expect(h.out.join('\n')).toContain('Codex environment snapshot');
    expect(h.out.join('\n')).not.toContain('must-not-be-printed');
  });

  it('rejects an unknown/missing action with usage (exit 1)', async () => {
    const missing = harness();
    expect(await runServiceCommand(['service'], missing.deps)).toBe(1);
    expect(missing.out.join('\n')).toContain('Usage');

    const unknown = harness();
    expect(await runServiceCommand(['service', 'frobnicate'], unknown.deps)).toBe(1);
  });

  it('routes macOS to the platform manager too (launchd)', async () => {
    const h = harness({ platform: 'darwin' });
    const code = await runServiceCommand(['service', 'install'], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual(['install']);
  });

  it('fails with guidance on unsupported platforms (freebsd)', async () => {
    const h = harness({ platform: 'freebsd' });
    const code = await runServiceCommand(['service', 'install'], h.deps);
    expect(code).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.out.join('\n')).toContain('Windows, Linux, and macOS');
  });

  it('surfaces a manager failure as exit 1 with the message', async () => {
    const h = harness();
    h.deps.makeManager = () => ({
      ...fakeManager().manager,
      install: async () => {
        throw new Error('systemd (systemctl) not found');
      },
    });
    const code = await runServiceCommand(['service', 'install'], h.deps);
    expect(code).toBe(1);
    expect(h.out.join('\n')).toContain('systemd (systemctl) not found');
  });
});

describe('service debug', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  /** A temp log layout: a daemon log + two api logs (the -2 stamp is newest). */
  function logFixture() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-debug-'));
    const daemonLog = path.join(tmpDir, 'portable-daemon.log');
    fs.writeFileSync(daemonLog, 'daemon line 1\ndaemon line 2\n');
    fs.writeFileSync(path.join(tmpDir, 'api-2026-01-01T00-00-00-000Z.log'), 'old api line\n');
    fs.writeFileSync(path.join(tmpDir, 'api-2026-01-02T00-00-00-000Z.log'), 'new api line\n');
    return { daemonLog, logsDir: tmpDir };
  }

  it('dumps status + the daemon and newest api log tails (exit 0, --no-follow)', async () => {
    const { daemonLog, logsDir } = logFixture();
    const h = harness({ platform: 'darwin' });
    h.deps.daemonLogPath = daemonLog;
    h.deps.logsDir = logsDir;

    const code = await runServiceCommand(['service', 'debug', '--no-follow'], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual(['status']);
    const text = h.out.join('\n');
    expect(text).toContain('installed');
    expect(text).toContain('daemon line 2');
    // Newest api log only — the older stamp must not be read.
    expect(text).toContain('new api line');
    expect(text).not.toContain('old api line');
  });

  it('points at the journal on Linux (no daemon log file there)', async () => {
    const { logsDir } = logFixture();
    const h = harness({ platform: 'linux' });
    h.deps.logsDir = logsDir;

    const code = await runServiceCommand(['service', 'debug', '--no-follow'], h.deps);
    expect(code).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('journalctl --user -u portable.service');
    expect(text).not.toContain('daemon log');
    expect(text).toContain('new api line');
  });

  it('reports a missing log instead of failing', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-debug-'));
    const h = harness({ platform: 'darwin' });
    h.deps.daemonLogPath = path.join(tmpDir, 'nope.log');
    h.deps.logsDir = path.join(tmpDir, 'no-such-dir');

    const code = await runServiceCommand(['service', 'debug', '--no-follow'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('none found');
  });

  it('follows the daemon log by default (macOS/Windows) via the follow seam', async () => {
    const { daemonLog, logsDir } = logFixture();
    const h = harness({ platform: 'darwin' });
    h.deps.daemonLogPath = daemonLog;
    h.deps.logsDir = logsDir;
    let followed: string[] = [];
    h.deps.followImpl = async (options) => {
      followed = options.resolvePaths();
    };

    const code = await runServiceCommand(['service', 'debug'], h.deps);
    expect(code).toBe(0);
    expect(followed).toEqual([daemonLog]);
  });

  it('follows the newest api log on Linux via the follow seam', async () => {
    const { logsDir } = logFixture();
    const h = harness({ platform: 'linux' });
    h.deps.logsDir = logsDir;
    let followed: string[] = [];
    h.deps.followImpl = async (options) => {
      followed = options.resolvePaths();
    };

    await runServiceCommand(['service', 'debug'], h.deps);
    expect(followed).toEqual([path.join(logsDir, 'api-2026-01-02T00-00-00-000Z.log')]);
  });
});

describe('debug helpers', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('latestApiLogPath picks the lexicographically newest api-*.log', () => {
    const listDir = () => [
      'api-2026-01-01T00-00-00-000Z.log',
      'api-2026-01-03T00-00-00-000Z.log',
      'api-2026-01-02T00-00-00-000Z.log',
      'portable-daemon.log', // not an api log
      'api-notes.txt', // wrong extension
    ];
    expect(latestApiLogPath('/logs', listDir)).toBe(
      path.join('/logs', 'api-2026-01-03T00-00-00-000Z.log')
    );
  });

  it('latestApiLogPath returns null on an empty/missing dir', () => {
    expect(latestApiLogPath('/logs', () => [])).toBeNull();
    expect(latestApiLogPath(path.join(os.tmpdir(), 'no-such-dir-xyz'))).toBeNull();
  });

  it('tailFile returns the last n lines (and null for a missing file)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-tail-'));
    const p = path.join(tmpDir, 'log.log');
    fs.writeFileSync(p, ['a', 'b', 'c', 'd'].join('\n') + '\n');
    expect(tailFile(p, 2)).toEqual(['c', 'd']);
    expect(tailFile(p, 10)).toEqual(['a', 'b', 'c', 'd']);
    expect(tailFile(path.join(tmpDir, 'missing.log'), 5)).toBeNull();
  });

  it('followLogs starts at EOF and emits only appended lines', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-follow-'));
    const p = path.join(tmpDir, 'portable-daemon.log');
    fs.writeFileSync(p, 'history — must NOT be re-emitted\n');
    const outLines: string[] = [];
    let ticks = 0;
    const promise = followLogs({
      resolvePaths: () => [p],
      out: (line) => outLines.push(line),
      pollMs: 5,
      shouldContinue: () => ticks++ < 5,
    });
    // Appended after the follow started (seeded at EOF) — must be emitted.
    fs.appendFileSync(p, 'fresh 1\nfresh 2\n');
    await promise;
    expect(outLines).toEqual(['fresh 1', 'fresh 2']);
  });

  it('followLogs picks up a file that appears mid-follow from byte 0 (log rotation)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-follow-'));
    const p = path.join(tmpDir, 'api-later.log');
    const outLines: string[] = [];
    let ticks = 0;
    const promise = followLogs({
      resolvePaths: () => [p],
      out: (line) => outLines.push(line),
      pollMs: 5,
      shouldContinue: () => ticks++ < 5,
    });
    fs.writeFileSync(p, 'born mid-follow\n');
    await promise;
    expect(outLines).toEqual(['born mid-follow']);
  });

  it('followLogs never tears a line flushed mid-write across two polls', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-follow-'));
    const p = path.join(tmpDir, 'portable-daemon.log');
    fs.writeFileSync(p, '');
    const outLines: string[] = [];
    // Drive the writes from shouldContinue (called at the top of each poll,
    // before that poll's read) for deterministic interleaving.
    let tick = 0;
    await followLogs({
      resolvePaths: () => [p],
      out: (line) => outLines.push(line),
      pollMs: 3,
      shouldContinue: () => {
        tick++;
        if (tick === 1) fs.appendFileSync(p, 'FATAL: ngrok not fo'); // partial, no newline
        if (tick === 2) fs.appendFileSync(p, 'und\n'); // completes the line
        return tick <= 4;
      },
    });
    // Emitted ONCE, whole — not ['FATAL: ngrok not fo', 'und'].
    expect(outLines).toEqual(['FATAL: ngrok not found']);
  });

  it('followLogs resets to byte 0 on truncation so cleared-then-fresh output is shown', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-follow-'));
    const p = path.join(tmpDir, 'portable-daemon.log');
    // Seed longer than the post-truncation content so `size < prev` is a real shrink.
    fs.writeFileSync(p, 'a long stale first line that exceeds the fresh content length\n');
    const outLines: string[] = [];
    let tick = 0;
    await followLogs({
      resolvePaths: () => [p],
      out: (line) => outLines.push(line),
      pollMs: 3,
      shouldContinue: () => {
        tick++;
        if (tick === 1) fs.writeFileSync(p, 'fresh\n'); // `> log` then fresh write
        return tick <= 4;
      },
    });
    expect(outLines).toEqual(['fresh']); // not dropped, not torn
  });

  it('followLogs strips a trailing CR (Windows CRLF logs)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-follow-'));
    const p = path.join(tmpDir, 'portable-daemon.log');
    fs.writeFileSync(p, '');
    const outLines: string[] = [];
    let tick = 0;
    await followLogs({
      resolvePaths: () => [p],
      out: (line) => outLines.push(line),
      pollMs: 3,
      shouldContinue: () => {
        tick++;
        if (tick === 1) fs.appendFileSync(p, 'line1\r\nline2\r\n');
        return tick <= 3;
      },
    });
    expect(outLines).toEqual(['line1', 'line2']);
  });

  it('followLogs never splits a multi-byte UTF-8 char at a read boundary', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-follow-'));
    const p = path.join(tmpDir, 'portable-daemon.log');
    fs.writeFileSync(p, '');
    const outLines: string[] = [];
    let tick = 0;
    // '→' is U+2192 → UTF-8 E2 86 92; split it across two polls.
    await followLogs({
      resolvePaths: () => [p],
      out: (line) => outLines.push(line),
      pollMs: 3,
      shouldContinue: () => {
        tick++;
        if (tick === 1) fs.appendFileSync(p, Buffer.from([0xe2, 0x86])); // first 2 bytes
        if (tick === 2) fs.appendFileSync(p, Buffer.from([0x92, 0x0a])); // last byte + newline
        return tick <= 4;
      },
    });
    expect(outLines).toEqual(['→']); // no U+FFFD garbage
  });
});
