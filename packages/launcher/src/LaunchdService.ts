/**
 * macOS background service via a launchd LaunchAgent (portable.dev#12 follow-up).
 *
 * A LaunchAgent (`~/Library/LaunchAgents/<label>.plist`, gui domain) — not a
 * root LaunchDaemon — for the same reason Linux uses a systemd USER unit: the
 * whole runtime is per-user (credentials, `~/.claude`, repos), and a root
 * daemon would run everything as the wrong user. `RunAtLoad` starts it at
 * login; `KeepAlive` restarts it on any crash/exit.
 *
 * launchctl mechanics (the modern bootstrap/bootout API, not the deprecated
 * load/unload):
 * - install(): write the plist → `enable` (a previous `disable` PERSISTS across
 *   bootouts in launchd) → `bootout` best-effort (reinstall idempotence — a
 *   second bootstrap of a loaded agent errors) → `bootstrap gui/<uid> <plist>`
 *   (RunAtLoad fires the process immediately).
 * - stop(): `bootout gui/<uid>/<label>` — unloading is the only stop KeepAlive
 *   cannot undo (a plain `launchctl kill` would be respawned). RunAtLoad brings
 *   it back at next login, matching the systemd stop semantics.
 * - start(): `enable` → `bootstrap` (already-loaded tolerated) → `kickstart`.
 * - status(): plist existence (installed) + `print gui/<uid>/<label>` exit code
 *   (loaded/active) + `print-disabled gui/<uid>` (enabled) + the loopback
 *   health probe (authoritative "is it actually up").
 *
 * Limitation (documented): a LaunchAgent starts at LOGIN, not at machine boot
 * with nobody logged in — same story as the Windows logon trigger. Auto-login
 * (or a future root LaunchDaemon mode) is the unattended-boot answer.
 *
 * Every effect is an injected seam so tests run anywhere.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { defaultDaemonLogPath } from './ServiceManager.js';
import { probeRuntimeHealth, runCommandReal } from './SystemdService.js';

import type {
  RunCommandResult,
  ServiceExecSpec,
  ServiceManager,
  ServiceStatus,
} from './ServiceManager.js';

export const LAUNCHD_LABEL = 'dev.portable.daemon';

/** `~/Library/LaunchAgents/dev.portable.daemon.plist`. */
export function defaultLaunchAgentPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** Escape a string for XML text content. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render the LaunchAgent plist: run the daemon at login (`RunAtLoad`), restart
 * it on any exit (`KeepAlive`), route stdout/stderr to a log file (the daemon
 * has no terminal — without this, pre-sink boot errors vanish), and bake the
 * captured operator env (launchd starts agents with a minimal PATH — see
 * {@link ServiceExecSpec.env}).
 */
export function renderLaunchdPlist(exec: ServiceExecSpec, logPath: string): string {
  const programArgs = [exec.command, ...exec.args]
    .map((token) => `    <string>${xmlEscape(token)}</string>`)
    .join('\n');
  const envEntries = Object.entries(exec.env ?? {});
  const envDict =
    envEntries.length > 0
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          ...envEntries.flatMap(([key, value]) => [
            `    <key>${xmlEscape(key)}</key>`,
            `    <string>${xmlEscape(value)}</string>`,
          ]),
          '  </dict>',
        ]
      : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArgs,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(exec.workingDirectory)}</string>`,
    ...envDict,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface LaunchdServiceDeps {
  /** The daemon invocation ({@link resolveServiceExec}). */
  exec: ServiceExecSpec;
  /** Plist path (defaults to {@link defaultLaunchAgentPath}). */
  plistPath?: string;
  /** The gui domain uid (defaults to `process.getuid()`). */
  uid?: number;
  /** Daemon stdout/stderr log file (defaults to {@link defaultDaemonLogPath}). */
  daemonLogPath?: string;
  /** Command runner seam (defaults to {@link runCommandReal}). */
  runCommand?: (cmd: string, args: string[]) => Promise<RunCommandResult>;
  /** Plist write seam (mkdir -p + write). */
  writeFile?: (p: string, content: string) => void;
  /** mkdir -p seam (the daemon-log dir — launchd won't create parent dirs). */
  ensureDir?: (dir: string) => void;
  /** Plist remove seam (best-effort). */
  removeFile?: (p: string) => void;
  /** Plist existence seam. */
  fileExists?: (p: string) => boolean;
  /** Loopback api health probe (defaults to {@link probeRuntimeHealth}). */
  probeHealth?: () => Promise<boolean>;
  /** Log sink (defaults to console.log). */
  log?: (line: string) => void;
}

export class LaunchdServiceManager implements ServiceManager {
  private readonly exec: ServiceExecSpec;
  private readonly plistPath: string;
  private readonly uid: number;
  private readonly daemonLogPath: string;
  private readonly run: (cmd: string, args: string[]) => Promise<RunCommandResult>;
  private readonly writeFile: (p: string, content: string) => void;
  private readonly ensureDir: (dir: string) => void;
  private readonly removeFile: (p: string) => void;
  private readonly fileExists: (p: string) => boolean;
  private readonly probeHealth: () => Promise<boolean>;
  private readonly log: (line: string) => void;

  constructor(deps: LaunchdServiceDeps) {
    this.exec = deps.exec;
    this.plistPath = deps.plistPath ?? defaultLaunchAgentPath();
    this.uid = deps.uid ?? process.getuid?.() ?? 501;
    this.daemonLogPath = deps.daemonLogPath ?? defaultDaemonLogPath();
    this.run = deps.runCommand ?? runCommandReal;
    this.writeFile =
      deps.writeFile ??
      ((p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, { mode: 0o644 });
      });
    this.ensureDir =
      deps.ensureDir ??
      ((dir) => {
        fs.mkdirSync(dir, { recursive: true });
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

  private get target(): string {
    return `gui/${this.uid}/${LAUNCHD_LABEL}`;
  }

  private launchctl(args: string[]): Promise<RunCommandResult> {
    return this.run('launchctl', args);
  }

  async install(): Promise<void> {
    // launchd creates the StandardOutPath FILE but not its parent dirs — on a
    // box that never ran interactive `portable` the log dir does not exist yet
    // and the daemon's output would be silently dropped.
    try {
      this.ensureDir(path.dirname(this.daemonLogPath));
    } catch {
      // Best-effort — a failed mkdir only costs the log file, not the daemon.
    }
    this.writeFile(this.plistPath, renderLaunchdPlist(this.exec, this.daemonLogPath));
    this.log(`[service] LaunchAgent written → ${this.plistPath}`);

    // A previous `launchctl disable` persists across bootouts — undo it first.
    await this.launchctl(['enable', this.target]);
    // Reinstall idempotence: bootstrap errors on an already-loaded agent.
    await this.launchctl(['bootout', this.target]); // best-effort (not loaded = fine)
    const bootstrap = await this.launchctl(['bootstrap', `gui/${this.uid}`, this.plistPath]);
    if (bootstrap.code !== 0) {
      throw new Error(
        `launchctl bootstrap failed: ${(bootstrap.stderr || bootstrap.stdout).trim()}`
      );
    }
    this.log('[service] installed + started (launchd LaunchAgent).');
  }

  /**
   * Register + enable auto-start WITHOUT starting now (PRD §10): ensure the log
   * dir, write the plist, and `enable` (undo any persisted `disable`) — but do
   * NOT `bootstrap`, because bootstrapping fires `RunAtLoad` and starts the
   * process immediately. The interactive handoff starts it later via
   * {@link start} once the manual runtime has released the api port. The plist's
   * `RunAtLoad` still starts it at the next login.
   */
  async installDefinition(): Promise<void> {
    try {
      this.ensureDir(path.dirname(this.daemonLogPath));
    } catch {
      // Best-effort — a failed mkdir only costs the log file, not the daemon.
    }
    this.writeFile(this.plistPath, renderLaunchdPlist(this.exec, this.daemonLogPath));
    this.log(`[service] LaunchAgent written → ${this.plistPath}`);
    // A previous `launchctl disable` persists across bootouts — undo it so a later
    // start()/next-login RunAtLoad is not silently blocked. No bootstrap here.
    await this.launchctl(['enable', this.target]);
    this.log('[service] definition installed + enabled (not started yet).');
  }

  async uninstall(): Promise<void> {
    // Best-effort: an already-unloaded agent is a fine uninstall outcome.
    await this.launchctl(['bootout', this.target]);
    this.removeFile(this.plistPath);
    this.log('[service] uninstalled (LaunchAgent removed).');
  }

  async start(): Promise<void> {
    await this.launchctl(['enable', this.target]);
    // Load if not loaded (already-loaded errors are fine), then poke it.
    await this.launchctl(['bootstrap', `gui/${this.uid}`, this.plistPath]);
    const kick = await this.launchctl(['kickstart', this.target]);
    if (kick.code !== 0) {
      throw new Error(`launchctl kickstart failed: ${(kick.stderr || kick.stdout).trim()}`);
    }
  }

  async stop(): Promise<void> {
    // bootout is the only stop KeepAlive cannot undo (`launchctl kill` would be
    // respawned). RunAtLoad reloads it at next login — same semantics as the
    // systemd stop.
    const bootout = await this.launchctl(['bootout', this.target]);
    if (bootout.code !== 0) {
      this.log(
        `[service] bootout: ${(bootout.stderr || bootout.stdout).trim() || `exit ${bootout.code}`} (already stopped?)`
      );
    }
  }

  async status(): Promise<ServiceStatus> {
    const print = await this.launchctl(['print', this.target]);
    const disabled = await this.launchctl(['print-disabled', `gui/${this.uid}`]);
    // print-disabled lists `"<label>" => disabled` for disabled services.
    const isDisabled = new RegExp(`"${LAUNCHD_LABEL}"\\s*=>\\s*disabled`).test(disabled.stdout);
    const installed = this.fileExists(this.plistPath);
    return {
      installed,
      enabled: installed && !isDisabled,
      active: print.code === 0,
      runtimeHealthy: await this.probeHealth(),
    };
  }
}
