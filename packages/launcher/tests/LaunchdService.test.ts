/**
 * LaunchdService tests — the macOS background-service manager (`portable
 * service …`), implemented as a launchd LaunchAgent (`~/Library/LaunchAgents`).
 * Every effect (launchctl runs, plist fs, health probe) is an injected seam.
 */
import { describe, expect, it } from 'bun:test';

import {
  LAUNCHD_LABEL,
  LaunchdServiceManager,
  defaultLaunchAgentPath,
  renderLaunchdPlist,
  type LaunchdServiceDeps,
} from '../src/LaunchdService.js';

import type { ServiceExecSpec } from '../src/ServiceManager.js';

const EXEC: ServiceExecSpec = {
  command: '/Users/u/.bun/bin/bun',
  args: ['/Users/u/.bun/install/global/cli.js', 'connect', '--service'],
  workingDirectory: '/Users/u',
};

function harness(
  opts: { commandResults?: Record<string, { code: number; stdout?: string; stderr?: string }> } = {}
) {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const log: string[] = [];
  const ensuredDirs: string[] = [];

  const deps: LaunchdServiceDeps = {
    exec: EXEC,
    plistPath: '/Users/u/Library/LaunchAgents/dev.portable.daemon.plist',
    uid: 501,
    daemonLogPath: '/Users/u/data/logs/portable-daemon.log',
    ensureDir: (dir) => {
      ensuredDirs.push(dir);
    },
    runCommand: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      commands.push(key);
      const result = opts.commandResults?.[key];
      return {
        code: result?.code ?? 0,
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
      };
    },
    writeFile: (p, content) => {
      files.set(p, content);
    },
    removeFile: (p) => {
      removed.push(p);
      files.delete(p);
    },
    fileExists: (p) => files.has(p),
    probeHealth: async () => true,
    log: (line) => log.push(line),
  };
  return { deps, commands, files, removed, log, ensuredDirs };
}

describe('renderLaunchdPlist', () => {
  it('renders a keep-alive run-at-load agent running the service exec', () => {
    const plist = renderLaunchdPlist(EXEC, '/Users/u/data/logs/portable-daemon.log');
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    // The full invocation, one <string> per token.
    expect(plist).toContain('<string>/Users/u/.bun/bin/bun</string>');
    expect(plist).toContain('<string>/Users/u/.bun/install/global/cli.js</string>');
    expect(plist).toContain('<string>connect</string>');
    expect(plist).toContain('<string>--service</string>');
    expect(plist).toContain('<string>/Users/u</string>'); // WorkingDirectory
    // Auto-start at login + auto-restart on crash (the two ACs).
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    // Early-boot stdout/stderr land in a log file (the daemon has no terminal).
    expect(plist).toContain('<string>/Users/u/data/logs/portable-daemon.log</string>');
  });

  it('XML-escapes path characters', () => {
    const plist = renderLaunchdPlist(
      { ...EXEC, workingDirectory: '/Users/u/A & B' },
      '/tmp/log.log'
    );
    expect(plist).toContain('<string>/Users/u/A &amp; B</string>');
  });

  it('bakes the captured operator env into EnvironmentVariables', () => {
    // launchd starts agents with a minimal PATH (/usr/bin:/bin:…) — without the
    // baked env, `ngrok` (Homebrew) and anything else outside it never resolve.
    const plist = renderLaunchdPlist(
      {
        ...EXEC,
        env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', PORTABLE_DATA_DIR: '/Users/u/.portable' },
      },
      '/tmp/log.log'
    );
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>');
    // A daemon-side re-resolve of the data dir would orphan every pairing.
    expect(plist).toContain('<key>PORTABLE_DATA_DIR</key>');
    expect(plist).toContain('<string>/Users/u/.portable</string>');
  });

  it('omits EnvironmentVariables when no env was captured', () => {
    expect(renderLaunchdPlist(EXEC, '/tmp/log.log')).not.toContain('EnvironmentVariables');
  });
});

describe('defaultLaunchAgentPath', () => {
  it('lives under ~/Library/LaunchAgents', () => {
    expect(defaultLaunchAgentPath('/Users/u')).toBe(
      `/Users/u/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
    );
  });
});

describe('LaunchdServiceManager', () => {
  it('install writes the plist, re-enables, reloads (bootout best-effort), and bootstraps', async () => {
    const h = harness({
      commandResults: {
        // Not loaded yet — bootout fails; install must shrug it off.
        [`launchctl bootout gui/501/${LAUNCHD_LABEL}`]: { code: 3, stderr: 'No such process' },
      },
    });
    await new LaunchdServiceManager(h.deps).install();

    expect(h.files.get('/Users/u/Library/LaunchAgents/dev.portable.daemon.plist')).toContain(
      '<key>KeepAlive</key>'
    );
    // launchd won't create StandardOutPath's parent dirs — install must.
    expect(h.ensuredDirs).toEqual(['/Users/u/data/logs']);
    expect(h.commands).toEqual([
      // enable first: a `disable` persists across bootouts in launchd.
      `launchctl enable gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 /Users/u/Library/LaunchAgents/dev.portable.daemon.plist`,
    ]);
  });

  it('installDefinition writes the plist + enables WITHOUT bootstrapping (no start)', async () => {
    const h = harness();
    await new LaunchdServiceManager(h.deps).installDefinition();

    expect(h.files.get('/Users/u/Library/LaunchAgents/dev.portable.daemon.plist')).toContain(
      '<key>KeepAlive</key>'
    );
    expect(h.ensuredDirs).toEqual(['/Users/u/data/logs']);
    // enable ONLY — no bootout/bootstrap (bootstrap fires RunAtLoad = start).
    expect(h.commands).toEqual([`launchctl enable gui/501/${LAUNCHD_LABEL}`]);
  });

  it('install surfaces a bootstrap failure', async () => {
    const h = harness({
      commandResults: {
        [`launchctl bootstrap gui/501 /Users/u/Library/LaunchAgents/dev.portable.daemon.plist`]: {
          code: 5,
          stderr: 'Bootstrap failed: 5: Input/output error',
        },
      },
    });
    await expect(new LaunchdServiceManager(h.deps).install()).rejects.toThrow(/Bootstrap failed/);
  });

  it('start enables + bootstraps (already-loaded tolerated) + kickstarts', async () => {
    const h = harness({
      commandResults: {
        [`launchctl bootstrap gui/501 /Users/u/Library/LaunchAgents/dev.portable.daemon.plist`]: {
          code: 37,
          stderr: 'Bootstrap failed: 37: Operation already in progress',
        },
      },
    });
    await new LaunchdServiceManager(h.deps).start();
    expect(h.commands).toEqual([
      `launchctl enable gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 /Users/u/Library/LaunchAgents/dev.portable.daemon.plist`,
      `launchctl kickstart gui/501/${LAUNCHD_LABEL}`,
    ]);
  });

  it('stop boots the agent out (KeepAlive cannot revive an unloaded agent)', async () => {
    const h = harness();
    await new LaunchdServiceManager(h.deps).stop();
    expect(h.commands).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
  });

  it('uninstall boots out and removes the plist', async () => {
    const h = harness();
    const manager = new LaunchdServiceManager(h.deps);
    await manager.install();
    await manager.uninstall();
    expect(h.removed).toEqual(['/Users/u/Library/LaunchAgents/dev.portable.daemon.plist']);
    expect(h.commands.slice(3)).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
  });

  it('status reports installed + enabled + loaded + runtime health', async () => {
    const h = harness({
      commandResults: {
        [`launchctl print gui/501/${LAUNCHD_LABEL}`]: { code: 0, stdout: 'state = running' },
        [`launchctl print-disabled gui/501`]: { code: 0, stdout: '{\n}' },
      },
    });
    h.deps.writeFile!('/Users/u/Library/LaunchAgents/dev.portable.daemon.plist', 'plist');
    const status = await new LaunchdServiceManager(h.deps).status();
    expect(status).toEqual({ installed: true, enabled: true, active: true, runtimeHealthy: true });
  });

  it('status reports a stopped (booted-out) or disabled agent', async () => {
    const h = harness({
      commandResults: {
        [`launchctl print gui/501/${LAUNCHD_LABEL}`]: {
          code: 113,
          stderr: 'Could not find service',
        },
        [`launchctl print-disabled gui/501`]: {
          code: 0,
          stdout: `{\n\t"${LAUNCHD_LABEL}" => disabled\n}`,
        },
      },
    });
    h.deps.probeHealth = async () => false;
    const status = await new LaunchdServiceManager(h.deps).status();
    expect(status).toEqual({
      installed: false,
      enabled: false,
      active: false,
      runtimeHealthy: false,
    });
  });
});
