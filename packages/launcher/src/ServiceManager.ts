/**
 * `portable service …` — shared surface for the per-platform background-service
 * managers (portable.dev#12).
 *
 * The daemon is the SAME launcher re-invoked headlessly: the service definition
 * (systemd unit on Linux, Scheduled Task on Windows) runs
 * `<bun> <cli entry> connect --service`. {@link resolveServiceExec} builds that
 * invocation from THIS process (same bun binary, same cli entry, the operator's
 * cwd as the working directory so `.env` discovery keeps working), so a source
 * checkout and a packaged global install both re-invoke exactly what the user
 * installed from.
 *
 * Platform managers: {@link ../SystemdService.SystemdServiceManager} (Linux) and
 * {@link ../WindowsTaskService.WindowsTaskServiceManager} (Windows). Both are
 * seam-injected (no real systemctl/schtasks in tests) and picked by
 * `ServiceCommands.ts`.
 */
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

/** How the service supervisor invokes the headless daemon. */
export interface ServiceExecSpec {
  /** Absolute path to the runtime binary (bun). */
  command: string;
  /** Arguments: the absolute cli entry + `connect --service` (+ forwarded flags). */
  args: string[];
  /**
   * Working directory for the daemon — the cwd `portable service install` ran
   * from, so the operator's `.env` (loaded by `loadOperatorEnv`) resolves the
   * same way it does for an interactive `portable`.
   */
  workingDirectory: string;
  /**
   * Env baked into the service definition. Supervisors start daemons with a
   * MINIMAL env — launchd gives LaunchAgents `/usr/bin:/bin:/usr/sbin:/sbin`
   * and systemd user units are similar, so nothing from the operator's shell
   * profile (Homebrew, `~/.bun/bin`, nvm) resolves there. Without this, the
   * daemon dies looking up `ngrok` (and anything else installed outside the
   * system PATH). Captured at install time from the interactive shell.
   */
  env?: Record<string, string>;
}

/** `<DATA_DIR>/logs/portable-daemon.log` — the daemon's stdout/stderr sink. */
export function defaultDaemonLogPath(): string {
  return path.join(resolveDataDir(), 'logs', 'portable-daemon.log');
}

/** Uniform cross-platform service state (printed by `portable service status`). */
export interface ServiceStatus {
  /** Is the service definition registered (unit file / scheduled task)? */
  installed: boolean;
  /** Is it enabled to start automatically? `null` when the platform can't tell. */
  enabled: boolean | null;
  /**
   * Is the supervisor reporting it active? `null` when the platform has no
   * locale-safe way to tell (Windows Task Scheduler) — `runtimeHealthy` is the
   * authoritative signal there.
   */
  active: boolean | null;
  /** Is the runtime actually serving `GET /api/health` on the loopback port? */
  runtimeHealthy: boolean | null;
}

/** The per-platform manager contract (`install` also starts; `uninstall` also stops). */
export interface ServiceManager {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
  /**
   * Register + enable the service definition WITHOUT starting it now (PRD §10).
   *
   * The interactive runtime→daemon handoff must create + enable auto-start, then
   * free the manual runtime, and only THEN start the supervised daemon — otherwise
   * the supervisor starts a second api/tunnel that fights (and kills) the CLI
   * showing the menu. `install()` remains the fused register+enable+start for the
   * scriptable, non-interactive `portable service install`. Optional so test fakes
   * (and any future manager) need not implement it — the {@link ServiceController}
   * falls back to `install()` when a manager omits it.
   */
  installDefinition?(): Promise<void>;
}

/** Result shape shared by the managers' injected command runners. */
export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Flags of the CURRENT invocation that carry over into the daemon invocation. */
export const FORWARDED_FLAGS = ['--dev', '--ngrok'] as const;

export interface ResolveServiceExecOptions {
  /** The runtime binary (defaults to `process.execPath` — bun). */
  execPath?: string;
  /** The current argv (defaults to `process.argv`); `[1]` is the cli entry. */
  argv?: string[];
  /** The operator's cwd (defaults to `process.cwd()`). */
  cwd?: string;
  /** The operator's env to capture from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** Env vars captured into the service definition when the operator has them set. */
const CAPTURED_ENV_VARS = ['PATH', 'PORTABLE_NGROK_BIN', 'PORTABLE_CLOUDFLARED_BIN'] as const;

/**
 * Build the invocation the service supervisor runs: THIS bun + THIS cli entry,
 * `connect --service`, plus the relay/tunnel flags (`--dev`, `--ngrok`) the
 * operator passed to `portable service install` so the daemon registers against
 * the same relay with the same tunnel provider. `--debug` is deliberately NOT
 * forwarded — it exists to stream logs to a terminal the daemon doesn't have.
 *
 * The operator's `PATH` (and explicit `PORTABLE_*_BIN` overrides) are captured
 * into `env` so the daemon resolves the same binaries the interactive shell
 * does — the supervisor's own env is minimal (see {@link ServiceExecSpec.env}).
 */
export function resolveServiceExec(options: ResolveServiceExecOptions = {}): ServiceExecSpec {
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const cwd = options.cwd ?? process.cwd();
  const baseEnv = options.env ?? process.env;
  const entry = path.resolve(cwd, argv[1] ?? '');
  const forwarded = FORWARDED_FLAGS.filter((flag) => argv.includes(flag));
  const env: Record<string, string> = {};
  for (const key of CAPTURED_ENV_VARS) {
    const value = baseEnv[key]?.trim();
    if (value) env[key] = value;
  }
  // ALWAYS pin the RESOLVED data dir: the supervisor's env differs from the
  // install shell's — a daemon-side re-resolve could land on a DIFFERENT store
  // (fresh JWT_SECRET/PSK/pcId) and orphan every paired phone. Path only, never a secret.
  env.PORTABLE_DATA_DIR = resolveDataDir(undefined, baseEnv);
  return {
    command: execPath,
    args: [entry, 'connect', '--service', ...forwarded],
    workingDirectory: cwd,
    env,
  };
}
