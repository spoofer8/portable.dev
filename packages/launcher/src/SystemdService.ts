/**
 * Linux background service via a systemd USER unit (portable.dev#12).
 *
 * Why a USER unit (not a system one): the whole runtime is per-user by design —
 * credentials live in the user's `LocalSecretStore`/`~/.claude`, `HOME` must be
 * the real user's home (LOCKED invariant), and repos live under the user's
 * workspace. A root system service would run everything as the wrong user.
 * Boot-start + logout survival come from `loginctl enable-linger <user>`, which
 * makes systemd start the user manager (and its enabled units) at boot without
 * an interactive login.
 *
 * install(): write `~/.config/systemd/user/portable.service` → `systemctl --user
 * daemon-reload` → `systemctl --user enable --now` → `loginctl enable-linger`
 * (best-effort — some polkit setups deny it; warned, not fatal).
 * Crash-restart is systemd's own `Restart=always`.
 *
 * Every effect (command runs, unit-file fs, health probe) is an injected seam so
 * tests run anywhere.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveApiPort } from './config.js';

import type {
  RunCommandResult,
  ServiceExecSpec,
  ServiceManager,
  ServiceStatus,
} from './ServiceManager.js';

export const SYSTEMD_UNIT_NAME = 'portable.service';

/** `$XDG_CONFIG_HOME/systemd/user/portable.service` (fallback `~/.config`). */
export function defaultUserUnitPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

/** Quote one ExecStart token (systemd unit syntax: double quotes, backslash escapes). */
function quoteUnitToken(token: string): string {
  return `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One `Environment="KEY=VALUE"` line. `%` is a systemd specifier in Environment=
 * values (`%h` = home, …) — a literal one must be doubled or the unit expands it.
 */
function environmentLine(key: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `Environment="${key}=${escaped}"`;
}

/** Render the user unit: restart-always daemon running the service exec. */
export function renderSystemdUnit(exec: ServiceExecSpec): string {
  const execStart = [exec.command, ...exec.args].map(quoteUnitToken).join(' ');
  return [
    '[Unit]',
    'Description=Portable local runtime (background daemon)',
    'Documentation=https://github.com/volter-ai/portable.dev',
    // The tunnel + relay registration need the network; user managers may not
    // have network-online.target, so Wants= keeps it a soft dependency.
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${exec.workingDirectory}`,
    // The captured operator env (PATH etc.) — a user unit's own env is minimal,
    // nothing from the login shell profile (see ServiceExecSpec.env).
    ...Object.entries(exec.env ?? {}).map(([key, value]) => environmentLine(key, value)),
    `ExecStart=${execStart}`,
    // Auto-restart on crash (AC): any exit — crash or clean — comes back.
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    // default.target = the user manager's boot target (with lingering enabled the
    // user manager itself starts at machine boot).
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Real command runner: resolves (never rejects) with code/stdout/stderr. */
export function runCommandReal(cmd: string, args: string[]): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err) }));
      child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: String(err) });
    }
  });
}

/** Real loopback `GET /api/health` probe (mirrors SingletonGuard's). */
export async function probeRuntimeHealth(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${resolveApiPort(env)}/api/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface SystemdServiceDeps {
  /** The daemon invocation ({@link resolveServiceExec}). */
  exec: ServiceExecSpec;
  /** Unit file path (defaults to {@link defaultUserUnitPath}). */
  unitPath?: string;
  /** User for `loginctl enable-linger` (defaults to `os.userInfo().username`). */
  username?: string;
  /** Command runner seam (defaults to {@link runCommandReal}). */
  runCommand?: (cmd: string, args: string[]) => Promise<RunCommandResult>;
  /** Unit-file write seam (mkdir -p + write). */
  writeFile?: (p: string, content: string) => void;
  /** Unit-file remove seam (best-effort). */
  removeFile?: (p: string) => void;
  /** Unit-file existence seam. */
  fileExists?: (p: string) => boolean;
  /** Loopback api health probe (defaults to {@link probeRuntimeHealth}). */
  probeHealth?: () => Promise<boolean>;
  /** Log sink (defaults to console.log). */
  log?: (line: string) => void;
}

const SYSTEMD_MISSING_HINT =
  'systemd (systemctl) is required for the background service on Linux. ' +
  'On systems without systemd (WSL without systemd enabled, some containers), run `portable` in a terminal instead.';

export class SystemdServiceManager implements ServiceManager {
  private readonly exec: ServiceExecSpec;
  private readonly unitPath: string;
  private readonly username: string;
  private readonly run: (cmd: string, args: string[]) => Promise<RunCommandResult>;
  private readonly writeFile: (p: string, content: string) => void;
  private readonly removeFile: (p: string) => void;
  private readonly fileExists: (p: string) => boolean;
  private readonly probeHealth: () => Promise<boolean>;
  private readonly log: (line: string) => void;

  constructor(deps: SystemdServiceDeps) {
    this.exec = deps.exec;
    this.unitPath = deps.unitPath ?? defaultUserUnitPath();
    this.username = deps.username ?? os.userInfo().username;
    this.run = deps.runCommand ?? runCommandReal;
    this.writeFile =
      deps.writeFile ??
      ((p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, { mode: 0o644 });
      });
    this.removeFile =
      deps.removeFile ??
      ((p) => {
        fs.rmSync(p, { force: true });
      });
    this.fileExists = deps.fileExists ?? ((p) => fs.existsSync(p));
    this.probeHealth = deps.probeHealth ?? (() => probeRuntimeHealth());
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Run a systemctl --user subcommand; throw a friendly hint on failure. */
  private async systemctl(args: string[]): Promise<RunCommandResult> {
    const result = await this.run('systemctl', ['--user', ...args]);
    if (result.code === 127 || /not found|No such file/i.test(result.stderr)) {
      throw new Error(SYSTEMD_MISSING_HINT);
    }
    return result;
  }

  async install(): Promise<void> {
    this.writeFile(this.unitPath, renderSystemdUnit(this.exec));
    this.log(`[service] unit written → ${this.unitPath}`);

    const reload = await this.systemctl(['daemon-reload']);
    if (reload.code !== 0) {
      throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
    }
    const enable = await this.systemctl(['enable', '--now', SYSTEMD_UNIT_NAME]);
    if (enable.code !== 0) {
      throw new Error(`systemctl --user enable --now failed: ${enable.stderr.trim()}`);
    }

    // Lingering = the user manager (and this unit) starts at BOOT and survives
    // logout. Best-effort: some polkit policies require an admin — the service
    // still works for the logged-in session, so warn instead of failing.
    const linger = await this.run('loginctl', ['enable-linger', this.username]);
    if (linger.code !== 0) {
      this.log(
        `[service] ⚠ loginctl enable-linger failed (${linger.stderr.trim() || `exit ${linger.code}`}) — ` +
          'without lingering the daemon only runs while you are logged in. ' +
          `Run \`sudo loginctl enable-linger ${this.username}\` to enable boot start.`
      );
    }
    this.log('[service] installed + started (systemd user unit).');
  }

  /**
   * Register + enable auto-start WITHOUT starting now (PRD §10): write the unit,
   * reload, `enable` (NOT `--now`, so systemd does not start it), and enable
   * lingering. The interactive handoff starts it later via {@link start} once the
   * manual runtime has released the api port.
   */
  async installDefinition(): Promise<void> {
    this.writeFile(this.unitPath, renderSystemdUnit(this.exec));
    this.log(`[service] unit written → ${this.unitPath}`);

    const reload = await this.systemctl(['daemon-reload']);
    if (reload.code !== 0) {
      throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
    }
    // `enable` (no `--now`): register auto-start but leave it stopped.
    const enable = await this.systemctl(['enable', SYSTEMD_UNIT_NAME]);
    if (enable.code !== 0) {
      throw new Error(`systemctl --user enable failed: ${enable.stderr.trim()}`);
    }
    const linger = await this.run('loginctl', ['enable-linger', this.username]);
    if (linger.code !== 0) {
      this.log(
        `[service] ⚠ loginctl enable-linger failed (${linger.stderr.trim() || `exit ${linger.code}`}) — ` +
          'without lingering the daemon only runs while you are logged in. ' +
          `Run \`sudo loginctl enable-linger ${this.username}\` to enable boot start.`
      );
    }
    this.log('[service] definition installed + enabled (not started yet).');
  }

  async uninstall(): Promise<void> {
    const disable = await this.systemctl(['disable', '--now', SYSTEMD_UNIT_NAME]);
    if (disable.code !== 0) {
      // A never-enabled/missing unit is fine — uninstall must be idempotent.
      this.log(`[service] disable --now: ${disable.stderr.trim() || `exit ${disable.code}`}`);
    }
    this.removeFile(this.unitPath);
    const reload = await this.systemctl(['daemon-reload']);
    if (reload.code !== 0) {
      throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
    }
    this.log('[service] uninstalled (systemd user unit removed).');
  }

  async start(): Promise<void> {
    const result = await this.systemctl(['start', SYSTEMD_UNIT_NAME]);
    if (result.code !== 0) {
      throw new Error(`systemctl --user start failed: ${result.stderr.trim()}`);
    }
  }

  async stop(): Promise<void> {
    const result = await this.systemctl(['stop', SYSTEMD_UNIT_NAME]);
    if (result.code !== 0) {
      throw new Error(`systemctl --user stop failed: ${result.stderr.trim()}`);
    }
  }

  async status(): Promise<ServiceStatus> {
    // `is-enabled`/`is-active` print stable, locale-independent tokens.
    const enabled = await this.systemctl(['is-enabled', SYSTEMD_UNIT_NAME]);
    const active = await this.systemctl(['is-active', SYSTEMD_UNIT_NAME]);
    return {
      installed: this.fileExists(this.unitPath),
      enabled: enabled.stdout.trim() === 'enabled',
      active: active.stdout.trim() === 'active',
      runtimeHealthy: await this.probeHealth(),
    };
  }
}
