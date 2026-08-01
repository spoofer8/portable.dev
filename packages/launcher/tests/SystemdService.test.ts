/**
 * SystemdService tests — the Linux background-service manager (`portable service …`).
 * Everything (systemctl/loginctl runs, unit-file fs) is an injected seam: no real
 * systemd is touched, so the suite runs anywhere (including macOS/Windows CI).
 */
import { describe, expect, it } from 'bun:test';

import {
  SYSTEMD_UNIT_NAME,
  SystemdServiceManager,
  defaultUserUnitPath,
  renderSystemdUnit,
  type SystemdServiceDeps,
} from '../src/SystemdService.js';

import type { ServiceExecSpec } from '../src/ServiceManager.js';

const EXEC: ServiceExecSpec = {
  command: '/home/u/.bun/bin/bun',
  args: ['/home/u/.bun/install/global/cli.js', 'connect', '--service'],
  workingDirectory: '/home/u',
};

describe('renderSystemdUnit env', () => {
  it('bakes the captured operator env as Environment= lines (%% for literal %)', () => {
    // A user unit's env is minimal — nothing from the login shell profile — so
    // the operator's PATH is baked in. `%` is a systemd specifier and must be
    // doubled to stay literal.
    const unit = renderSystemdUnit({
      ...EXEC,
      env: {
        PATH: '/home/u/.bun/bin:/usr/bin',
        PORTABLE_NGROK_BIN: '/opt/ngrok/100%/ngrok',
        PORTABLE_DATA_DIR: '/home/u/.portable',
      },
    });
    expect(unit).toContain('Environment="PATH=/home/u/.bun/bin:/usr/bin"');
    expect(unit).toContain('Environment="PORTABLE_NGROK_BIN=/opt/ngrok/100%%/ngrok"');
    // A daemon-side re-resolve of the data dir would orphan every pairing.
    expect(unit).toContain('Environment="PORTABLE_DATA_DIR=/home/u/.portable"');
  });

  it('renders no Environment= line when no env was captured', () => {
    expect(renderSystemdUnit(EXEC)).not.toContain('Environment=');
  });
});

/** Fake seam set recording every command + fs effect. */
function harness(
  opts: { commandResults?: Record<string, { code: number; stdout?: string; stderr?: string }> } = {}
) {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const log: string[] = [];

  const deps: SystemdServiceDeps = {
    exec: EXEC,
    unitPath: '/home/u/.config/systemd/user/portable.service',
    username: 'u',
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
  return { deps, commands, files, removed, log };
}

describe('renderSystemdUnit', () => {
  it('renders a restart-always user unit running the service exec', () => {
    const unit = renderSystemdUnit(EXEC);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain(
      'ExecStart="/home/u/.bun/bin/bun" "/home/u/.bun/install/global/cli.js" "connect" "--service"'
    );
    expect(unit).toContain('WorkingDirectory=/home/u');
    // Auto-restart on crash + start at (user-session) boot.
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('WantedBy=default.target');
    // Come up after the network is reachable (the tunnel needs it).
    expect(unit).toContain('After=network-online.target');
  });
});

describe('defaultUserUnitPath', () => {
  it('honors XDG_CONFIG_HOME', () => {
    expect(defaultUserUnitPath({ XDG_CONFIG_HOME: '/xdg' } as NodeJS.ProcessEnv, '/home/u')).toBe(
      `/xdg/systemd/user/${SYSTEMD_UNIT_NAME}`
    );
  });
  it('falls back to ~/.config', () => {
    expect(defaultUserUnitPath({} as NodeJS.ProcessEnv, '/home/u')).toBe(
      `/home/u/.config/systemd/user/${SYSTEMD_UNIT_NAME}`
    );
  });
});

describe('SystemdServiceManager', () => {
  it('install writes the unit, reloads, enables --now, and enables lingering', async () => {
    const h = harness();
    await new SystemdServiceManager(h.deps).install();

    expect(h.files.get('/home/u/.config/systemd/user/portable.service')).toContain(
      'Restart=always'
    );
    expect(h.commands).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
      'loginctl enable-linger u',
    ]);
  });

  it('installDefinition registers + enables WITHOUT starting (no --now)', async () => {
    const h = harness();
    await new SystemdServiceManager(h.deps).installDefinition();

    expect(h.files.get('/home/u/.config/systemd/user/portable.service')).toContain(
      'Restart=always'
    );
    // `enable` (not `enable --now`) — the daemon is registered + enabled but NOT
    // started; the interactive handoff starts it after freeing the manual runtime.
    expect(h.commands).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${SYSTEMD_UNIT_NAME}`,
      'loginctl enable-linger u',
    ]);
  });

  it('install still succeeds when enable-linger fails (warned, not fatal)', async () => {
    const h = harness({
      commandResults: { 'loginctl enable-linger u': { code: 1, stderr: 'polkit denied' } },
    });
    await new SystemdServiceManager(h.deps).install();
    expect(h.log.join('\n')).toContain('enable-linger');
  });

  it('install throws a friendly hint when systemctl is unavailable', async () => {
    const h = harness({
      commandResults: {
        'systemctl --user daemon-reload': { code: 127, stderr: 'systemctl: not found' },
      },
    });
    await expect(new SystemdServiceManager(h.deps).install()).rejects.toThrow(/systemd/);
  });

  it('uninstall disables, removes the unit, and reloads', async () => {
    const h = harness();
    const manager = new SystemdServiceManager(h.deps);
    await manager.install();
    await manager.uninstall();

    expect(h.removed).toEqual(['/home/u/.config/systemd/user/portable.service']);
    expect(h.commands.slice(3)).toEqual([
      `systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`,
      'systemctl --user daemon-reload',
    ]);
  });

  it('start/stop drive systemctl --user', async () => {
    const h = harness();
    const manager = new SystemdServiceManager(h.deps);
    await manager.start();
    await manager.stop();
    expect(h.commands).toEqual([
      `systemctl --user start ${SYSTEMD_UNIT_NAME}`,
      `systemctl --user stop ${SYSTEMD_UNIT_NAME}`,
    ]);
  });

  it('status reports installed + enabled + active + runtime health', async () => {
    const h = harness({
      commandResults: {
        [`systemctl --user is-enabled ${SYSTEMD_UNIT_NAME}`]: { code: 0, stdout: 'enabled\n' },
        [`systemctl --user is-active ${SYSTEMD_UNIT_NAME}`]: { code: 0, stdout: 'active\n' },
      },
    });
    h.deps.writeFile!('/home/u/.config/systemd/user/portable.service', 'unit');
    const status = await new SystemdServiceManager(h.deps).status();
    expect(status).toEqual({ installed: true, enabled: true, active: true, runtimeHealthy: true });
  });

  it('status reports a missing install', async () => {
    const h = harness({
      commandResults: {
        [`systemctl --user is-enabled ${SYSTEMD_UNIT_NAME}`]: { code: 1, stdout: 'not-found\n' },
        [`systemctl --user is-active ${SYSTEMD_UNIT_NAME}`]: { code: 3, stdout: 'inactive\n' },
      },
    });
    h.deps.probeHealth = async () => false;
    const status = await new SystemdServiceManager(h.deps).status();
    expect(status).toEqual({
      installed: false,
      enabled: false,
      active: false,
      runtimeHealthy: false,
    });
  });
});
