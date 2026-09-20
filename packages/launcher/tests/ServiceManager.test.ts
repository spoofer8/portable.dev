/**
 * ServiceManager tests — the shared service-exec resolution used by BOTH platform
 * managers (systemd unit + Windows Scheduled Task). The spec re-invokes THIS
 * install of portable (same bun binary + same cli entry) headlessly.
 */
import { describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';

import { renderLaunchdPlist } from '../src/LaunchdService.js';
import { resolveServiceExec } from '../src/ServiceManager.js';

describe('resolveServiceExec', () => {
  it('re-invokes this bun + cli entry with `connect --service`', () => {
    const spec = resolveServiceExec({
      execPath: '/home/u/.bun/bin/bun',
      argv: ['/home/u/.bun/bin/bun', '/home/u/.bun/install/global/cli.js', 'service', 'install'],
      cwd: '/home/u/projects',
    });
    expect(spec.command).toBe('/home/u/.bun/bin/bun');
    expect(spec.args).toEqual(['/home/u/.bun/install/global/cli.js', 'connect', '--service']);
    expect(spec.workingDirectory).toBe('/home/u/projects');
  });

  it('resolves a relative cli entry against cwd', () => {
    const spec = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', 'src/cli.ts', 'service', 'install'],
      cwd: '/repo/packages/launcher',
    });
    expect(spec.args[0]).toBe('/repo/packages/launcher/src/cli.ts');
  });

  it('forwards --dev and --ngrok into the service invocation (nothing else)', () => {
    const spec = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: [
        '/usr/local/bin/bun',
        '/g/cli.js',
        'service',
        'install',
        '--dev',
        '--ngrok',
        '--debug',
      ],
      cwd: '/home/u',
    });
    // --debug is terminal-streaming only — meaningless in a daemon, NOT forwarded.
    expect(spec.args).toEqual(['/g/cli.js', 'connect', '--service', '--dev', '--ngrok']);
  });

  it('captures the operator PATH + explicit *_BIN overrides into the service env', () => {
    // Supervisors (launchd/systemd/Task Scheduler) start daemons with a minimal
    // env — without this capture, `ngrok`/`bun` lookups die under the service.
    const spec = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', '/g/cli.js', 'service', 'install', '--ngrok'],
      cwd: '/home/u',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        PORTABLE_NGROK_BIN: '/opt/homebrew/bin/ngrok',
        HOME: '/home/u', // NOT captured — only PATH + *_BIN overrides
      },
    });
    expect(spec.env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      PORTABLE_NGROK_BIN: '/opt/homebrew/bin/ngrok',
      PORTABLE_DATA_DIR: path.join(os.homedir(), '.portable'),
    });
  });

  it('omits captured env vars the operator does not have set', () => {
    const spec = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', '/g/cli.js', 'service', 'install'],
      cwd: '/home/u',
      env: { PATH: '/usr/bin' },
    });
    expect(spec.env).toEqual({
      PATH: '/usr/bin',
      PORTABLE_DATA_DIR: path.join(os.homedir(), '.portable'),
    });
  });

  it('always pins the RESOLVED data dir as PORTABLE_DATA_DIR in the service env', () => {
    // Without the pin the daemon re-resolves under a different env → a
    // different store (fresh JWT_SECRET/PSK/pcId) and every pairing goes invalid.
    const fromXdg = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', '/g/cli.js', 'service', 'install'],
      cwd: '/home/u',
      env: { XDG_DATA_HOME: '/tmp/xdg' },
    });
    expect(fromXdg.env?.PORTABLE_DATA_DIR).toBe(path.join('/tmp/xdg', 'portable'));

    const fromExplicit = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', '/g/cli.js', 'service', 'install'],
      cwd: '/home/u',
      env: { PORTABLE_DATA_DIR: '/custom' },
    });
    expect(fromExplicit.env?.PORTABLE_DATA_DIR).toBe('/custom');

    const fromDefault = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', '/g/cli.js', 'service', 'install'],
      cwd: '/home/u',
      env: {},
    });
    expect(fromDefault.env?.PORTABLE_DATA_DIR).toBe(path.join(os.homedir(), '.portable'));
  });

  it('never puts Codex provider keys in service env, argv, or a LaunchAgent plist', () => {
    const spec = resolveServiceExec({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', '/g/cli.js', 'service', 'install'],
      cwd: '/Users/u',
      env: {
        PATH: '/usr/bin:/bin',
        AZURE_API_KEY: 'azure-must-stay-encrypted',
        CLIPROXY_API_KEY: 'cliproxy-must-stay-encrypted',
        PORTABLE_CODEX_ENV_ALLOWLIST: 'CUSTOM_PROVIDER_KEY',
        CUSTOM_PROVIDER_KEY: 'custom-must-stay-encrypted',
      },
    });
    const serialized = `${JSON.stringify(spec)}\n${renderLaunchdPlist(spec, '/tmp/log')}`;
    for (const forbidden of [
      'AZURE_API_KEY',
      'CLIPROXY_API_KEY',
      'CUSTOM_PROVIDER_KEY',
      'azure-must-stay-encrypted',
      'cliproxy-must-stay-encrypted',
      'custom-must-stay-encrypted',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
