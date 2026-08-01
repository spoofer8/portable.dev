/**
 * Windows background service via a Scheduled Task (portable.dev#12).
 *
 * Why a Scheduled Task, not `sc create`: a plain console app (bun) can't answer
 * the Service Control Manager handshake — registering it as a real Windows
 * Service fails with error 1053 unless we ship a service wrapper (NSSM/WinSW).
 * Task Scheduler natively supports run-at-logon, restart-on-failure, and
 * unlimited execution time, which covers the daemon ACs without extra binaries.
 * The task MUST be registered from generated XML: schtasks.exe's CLI flags
 * cannot express `RestartOnFailure` (only the XML schema can).
 *
 * The action is wrapped in `powershell.exe -WindowStyle Hidden` so no console
 * window pops into the user's session at logon (bun is a console app).
 *
 * ⚠️ stop(): `schtasks /End` only terminates the task's ROOT process (the
 * powershell wrapper) — the bun runtime underneath survives. So stop() first
 * DISABLES the task (so `RestartOnFailure` can't revive it), ends it, then
 * tree-kills the actual runtime via {@link stopRunningInstance} (health probe +
 * lock-pid taskkill /T — the same machinery the singleton takeover uses).
 *
 * Limitation (documented): a logon-triggered task starts at USER LOGON, not at
 * machine boot with nobody logged in. A boot trigger would need a stored
 * password / S4U principal (admin + policy territory) — out of scope for v1.
 *
 * Every effect (schtasks runs, XML file write, the runtime kill) is an injected
 * seam so tests run anywhere.
 */
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

import { defaultDaemonLogPath } from './ServiceManager.js';
import { stopRunningInstance } from './SingletonGuard.js';
import { probeRuntimeHealth, runCommandReal } from './SystemdService.js';

import type {
  RunCommandResult,
  ServiceExecSpec,
  ServiceManager,
  ServiceStatus,
} from './ServiceManager.js';

export const WINDOWS_TASK_NAME = 'Portable';

/** `<DATA_DIR>/portable-task.xml` — where install() materializes the task XML. */
export function defaultTaskXmlPath(): string {
  return path.join(resolveDataDir(), 'portable-task.xml');
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

/** Quote a token for a PowerShell single-quoted string (' doubles inside). */
function psQuote(token: string): string {
  return `'${token.replace(/'/g, "''")}'`;
}

/**
 * Render the Scheduled Task definition XML: run the daemon at THIS user's logon,
 * hidden, restart on failure every minute (effectively forever), no execution
 * time limit, and never blocked by battery power.
 *
 * The captured operator env (PATH etc., see `ServiceExecSpec.env`) is applied as
 * `$env:` assignments inside the wrapper — a logon task gets the registry env,
 * not the shell profile's. With `logPath`, the daemon's stdout/stderr are
 * appended there (parity with the launchd/systemd sinks — without it, early-boot
 * errors of the hidden task vanish).
 */
export function renderTaskXml(options: {
  exec: ServiceExecSpec;
  userId: string;
  logPath?: string;
}): string {
  const { exec, userId, logPath } = options;
  // powershell -Command "& '<bun>' '<cli>' 'connect' '--service'" — the child
  // console app attaches to powershell's (hidden) console, so nothing flashes.
  //
  // Captured env values are STRIPPED of `"` before being embedded: the payload
  // is wrapped in double quotes for the process command line, and a `"` anywhere
  // inside it (even inside a PS single-quoted string) toggles argv-layer quoting
  // and corrupts the reassembled command. `"` is meaningless in a Windows PATH
  // entry (the resolver ignores it), so stripping is loss-free and keeps the
  // "payload only uses single quotes" invariant the outer `"..."` wrap relies on.
  const envPrefix = Object.entries(exec.env ?? {})
    .map(([key, value]) => `$env:${key} = ${psQuote(value.replace(/"/g, ''))}; `)
    .join('');
  let preamble = '';
  let redirect = '';
  if (logPath) {
    // (1) Force UTF-8 so bun's UTF-8 output isn't OEM-mojibake'd by PS 5.1's
    //     default [Console]::OutputEncoding on the way into Out-File.
    // (2) Self-heal the log dir every start — Out-File throws a terminating error
    //     on a missing parent (killing the task before the daemon runs), and the
    //     dir can vanish after install (disk cleanup) with no other recreation.
    const logDir = path.win32.dirname(logPath);
    preamble =
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
      `New-Item -ItemType Directory -Force -Path ${psQuote(logDir)} -ErrorAction SilentlyContinue | Out-Null; `;
    // `; exit $LASTEXITCODE` propagates bun's exit code past the Out-File cmdlet
    // (otherwise powershell exits 0 on a daemon crash — the run reads as success,
    // and the operator-visible failure signal in Task Scheduler is destroyed).
    // KNOWN LIMITATION (Windows device QA): `2>&1` routes the daemon's stderr
    // through the PS object pipeline, so PS 5.1 wraps each native stderr line in a
    // NativeCommandError block in the log. The byte-faithful fix (cmd /c `>>`
    // redirection, or Start-Process) needs a Windows box to verify quoting — the
    // fatal's text still lands in the log, just decorated.
    redirect = ` 2>&1 | Out-File -Append -Encoding utf8 -FilePath ${psQuote(logPath)}; exit $LASTEXITCODE`;
  }
  const wrapped = `${preamble}${envPrefix}& ${[exec.command, ...exec.args].map(psQuote).join(' ')}${redirect}`;
  // Double-quote the -Command payload for the process command line (the payload
  // itself only uses single quotes — paths can't contain `"`, and env values are
  // stripped of it above — so no inner escaping is needed) and let xmlEscape
  // handle the XML layer. Backslashes stay literal — PowerShell does not treat
  // them as escapes.
  const argumentsLine = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ${xmlEscape(`"${wrapped}"`)}`;
  const user = xmlEscape(userId);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Portable local runtime (background daemon) — https://github.com/volter-ai/portable.dev</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>999</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>powershell.exe</Command>',
    `      <Arguments>${argumentsLine}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(exec.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/** `DOMAIN\user` from the env (the id Task Scheduler registers the task under). */
export function defaultWindowsUserId(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERNAME?.trim() || 'user';
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${user}` : user;
}

export interface WindowsTaskServiceDeps {
  /** The daemon invocation ({@link resolveServiceExec}). */
  exec: ServiceExecSpec;
  /** `DOMAIN\user` (defaults to {@link defaultWindowsUserId}). */
  userId?: string;
  /** Where to write the task XML (defaults to {@link defaultTaskXmlPath}). */
  xmlPath?: string;
  /** Daemon stdout/stderr log file (defaults to {@link defaultDaemonLogPath}). */
  daemonLogPath?: string;
  /** Command runner seam (defaults to {@link runCommandReal}). */
  runCommand?: (cmd: string, args: string[]) => Promise<RunCommandResult>;
  /** XML write seam (mkdir -p + write). */
  writeFile?: (p: string, content: string) => void;
  /** mkdir -p seam (the daemon-log dir — Out-File won't create parent dirs). */
  ensureDir?: (dir: string) => void;
  /** Tree-kill the running runtime (defaults to {@link stopRunningInstance}). */
  stopRunningInstance?: () => Promise<void>;
  /** Loopback api health probe (defaults to {@link probeRuntimeHealth}). */
  probeHealth?: () => Promise<boolean>;
  /** Log sink (defaults to console.log). */
  log?: (line: string) => void;
}

export class WindowsTaskServiceManager implements ServiceManager {
  private readonly exec: ServiceExecSpec;
  private readonly userId: string;
  private readonly xmlPath: string;
  private readonly daemonLogPath: string;
  private readonly run: (cmd: string, args: string[]) => Promise<RunCommandResult>;
  private readonly writeFile: (p: string, content: string) => void;
  private readonly ensureDir: (dir: string) => void;
  private readonly stopRunning: () => Promise<void>;
  private readonly probeHealth: () => Promise<boolean>;
  private readonly log: (line: string) => void;

  constructor(deps: WindowsTaskServiceDeps) {
    this.exec = deps.exec;
    this.userId = deps.userId ?? defaultWindowsUserId();
    this.xmlPath = deps.xmlPath ?? defaultTaskXmlPath();
    this.daemonLogPath = deps.daemonLogPath ?? defaultDaemonLogPath();
    this.run = deps.runCommand ?? runCommandReal;
    this.writeFile =
      deps.writeFile ??
      ((p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      });
    this.ensureDir =
      deps.ensureDir ??
      ((dir) => {
        fs.mkdirSync(dir, { recursive: true });
      });
    this.stopRunning =
      deps.stopRunningInstance ??
      (async () => {
        await stopRunningInstance({ log: deps.log });
      });
    this.probeHealth = deps.probeHealth ?? (() => probeRuntimeHealth());
    this.log = deps.log ?? ((line) => console.log(line));
  }

  private schtasks(args: string[]): Promise<RunCommandResult> {
    return this.run('schtasks', args);
  }

  async install(): Promise<void> {
    // Out-File (the wrapper's log redirect) errors out on a missing parent dir,
    // which would kill the hidden task before the daemon even starts — ensure
    // the log dir exists up front. win32 dirname so the backslash path parses
    // on any host (this path is exercised in tests on macOS/Linux too).
    try {
      this.ensureDir(path.win32.dirname(this.daemonLogPath));
    } catch {
      // Best-effort — worst case the wrapper fails and RestartOnFailure retries.
    }
    this.writeFile(
      this.xmlPath,
      renderTaskXml({ exec: this.exec, userId: this.userId, logPath: this.daemonLogPath })
    );
    const create = await this.schtasks([
      '/Create',
      '/TN',
      WINDOWS_TASK_NAME,
      '/XML',
      this.xmlPath,
      '/F',
    ]);
    if (create.code !== 0) {
      throw new Error(`schtasks /Create failed: ${(create.stderr || create.stdout).trim()}`);
    }
    // Start it right away — install() means "daemon is on from now on" (parity
    // with systemd's enable --now).
    const start = await this.schtasks(['/Run', '/TN', WINDOWS_TASK_NAME]);
    if (start.code !== 0) {
      this.log(
        `[service] ⚠ task registered but /Run failed (${(start.stderr || start.stdout).trim()}) — it will start at next logon.`
      );
    }
    this.log('[service] installed + started (Windows Scheduled Task).');
  }

  /**
   * Register + enable the task WITHOUT starting it now (PRD §10): ensure the log
   * dir, write the XML, and `/Create` the task (a LogonTrigger task is enabled and
   * will start at the next logon) — but do NOT `/Run`. The interactive handoff
   * starts it later via {@link start} once the manual runtime has released the api
   * port.
   */
  async installDefinition(): Promise<void> {
    try {
      this.ensureDir(path.win32.dirname(this.daemonLogPath));
    } catch {
      // Best-effort — worst case the wrapper fails and RestartOnFailure retries.
    }
    this.writeFile(
      this.xmlPath,
      renderTaskXml({ exec: this.exec, userId: this.userId, logPath: this.daemonLogPath })
    );
    const create = await this.schtasks([
      '/Create',
      '/TN',
      WINDOWS_TASK_NAME,
      '/XML',
      this.xmlPath,
      '/F',
    ]);
    if (create.code !== 0) {
      throw new Error(`schtasks /Create failed: ${(create.stderr || create.stdout).trim()}`);
    }
    this.log('[service] definition installed + enabled (not started yet).');
  }

  async uninstall(): Promise<void> {
    // Best-effort stop first (disable → end → kill the runtime tree).
    await this.stop();
    const del = await this.schtasks(['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
    if (del.code !== 0) {
      // Idempotent: a missing task is a fine uninstall outcome.
      this.log(`[service] /Delete: ${(del.stderr || del.stdout).trim() || `exit ${del.code}`}`);
    }
    this.log('[service] uninstalled (Scheduled Task removed).');
  }

  async start(): Promise<void> {
    // Re-enable first — stop() disables the task to keep RestartOnFailure from
    // reviving it, so start() must undo that before running.
    const enable = await this.schtasks(['/Change', '/TN', WINDOWS_TASK_NAME, '/ENABLE']);
    if (enable.code !== 0) {
      throw new Error(
        `schtasks /Change /ENABLE failed: ${(enable.stderr || enable.stdout).trim()}`
      );
    }
    const start = await this.schtasks(['/Run', '/TN', WINDOWS_TASK_NAME]);
    if (start.code !== 0) {
      throw new Error(`schtasks /Run failed: ${(start.stderr || start.stdout).trim()}`);
    }
  }

  async stop(): Promise<void> {
    // Order matters: disable BEFORE ending, or RestartOnFailure restarts the
    // task the moment we kill it.
    await this.schtasks(['/Change', '/TN', WINDOWS_TASK_NAME, '/DISABLE']);
    await this.schtasks(['/End', '/TN', WINDOWS_TASK_NAME]);
    // /End killed the powershell wrapper only — take down the bun runtime too.
    await this.stopRunning();
  }

  async status(): Promise<ServiceStatus> {
    // /Query /XML is locale-safe (the LIST output is localized); exit 0 = the
    // task exists, and <Enabled>false</Enabled> in Settings = disabled by stop().
    const query = await this.schtasks(['/Query', '/TN', WINDOWS_TASK_NAME, '/XML']);
    const installed = query.code === 0;
    const enabled = installed && !/<Enabled>\s*false\s*<\/Enabled>/i.test(query.stdout);
    return {
      installed,
      enabled,
      // Task Scheduler has no locale-safe run-state query — the loopback health
      // probe below is the authoritative "is it actually up" signal.
      active: null,
      runtimeHealthy: await this.probeHealth(),
    };
  }
}
