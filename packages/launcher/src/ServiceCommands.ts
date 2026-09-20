/**
 * `portable service <install|uninstall|start|stop|status|debug>` — the CLI
 * dispatch for the persistent background daemon (portable.dev#12).
 *
 * Picks the platform manager (systemd user unit on Linux, Scheduled Task on
 * Windows, launchd LaunchAgent on macOS), routes the action, and prints a human
 * summary. The service definition re-invokes THIS install of portable headlessly
 * (`connect --service`), so the daemon uses the same persisted pcId / JWT secret
 * / credentials the interactive run set up — a paired phone reconnects to it
 * without re-scanning.
 */
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

import { DaemonRuntimeStateStore } from './DaemonRuntimeStateStore.js';
import { LaunchdServiceManager } from './LaunchdService.js';
import {
  captureServiceCodexEnvironment,
  deleteServiceCodexEnvironment,
} from './ServiceCodexEnvironment.js';
import {
  persistServiceInstallManifest,
  removeServiceInstallManifest,
} from './ServiceInstallManifest.js';
import {
  defaultDaemonLogPath,
  resolveServiceExec,
  type ServiceManager,
  type ServiceStatus,
} from './ServiceManager.js';
import { SystemdServiceManager } from './SystemdService.js';
import { WindowsTaskServiceManager } from './WindowsTaskService.js';

export const SERVICE_USAGE = `Usage: portable service <install|uninstall|start|stop|restart|status|debug>

  install    Install + start the background daemon (auto-start at boot/logon,
             auto-restart on crash). Run \`portable\` interactively FIRST to pair
             your phone — the daemon reuses that pairing.
  uninstall  Stop the daemon and remove the service definition.
  start      Start the installed daemon now.
  stop       Stop the daemon (until \`start\` or the next boot trigger).
  restart    Stop then start the daemon.
  status     Show installed/enabled/running state (exit 0 when healthy).
  debug      Show the state + the recent daemon logs, then keep following them
             live (Ctrl-C to exit; --no-follow for a one-shot dump).

Run \`portable service\` with no action to open the interactive Services menu.

Flags on install: --dev (staging relay) and --ngrok (ngrok tunnel) carry over
into the daemon. Linux: systemd user unit + lingering. Windows: Scheduled Task
at logon. macOS: launchd LaunchAgent at login.
`;

const ACTIONS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'debug'] as const;
type ServiceAction = (typeof ACTIONS)[number];

/** Lines shown per log in the one-shot `service debug` dump. */
const DEBUG_TAIL_LINES = 60;
/** How much of a log file the tail reads back at most (logs can be huge). */
const TAIL_READ_BYTES = 256 * 1024;

export interface ServiceCommandsDeps {
  /** Platform switch (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Manager factory seam (tests). Defaults to the real per-platform managers. */
  makeManager?: (platform: NodeJS.Platform, args: string[]) => ServiceManager;
  /** Output sink (defaults to stdout). */
  out?: (line: string) => void;
  /** `service debug`: daemon log path (defaults to {@link defaultDaemonLogPath}). */
  daemonLogPath?: string;
  /** `service debug`: api-log dir (defaults to `<DATA_DIR>/logs`). */
  logsDir?: string;
  /** `service debug`: follow-loop seam (defaults to {@link followLogs}). */
  followImpl?: typeof followLogs;
  /**
   * `service install`: freeze the cwd-independent install manifest (PRD §5) so a
   * later `portable`/dashboard from any dir finds the daemon's real config.
   * Defaults to the real writer; tests inject a no-op to avoid touching DATA_DIR.
   */
  persistManifest?: () => void;
  /** `service uninstall`: remove the manifest + runtime-state (defaults to the real remover). */
  clearInstallArtifacts?: () => void;
  /** Capture the invoking shell's allowlisted Codex env before the service starts. */
  captureCodexEnvironment?: () => void;
  /** Remove only the encrypted Codex env snapshot on uninstall. */
  clearCodexEnvironment?: () => void;
}

/** The real per-platform manager, built from THIS invocation's exec spec. */
export function makeManagerReal(platform: NodeJS.Platform, args: string[]): ServiceManager {
  const exec = resolveServiceExec({
    argv: [process.argv[0] ?? '', process.argv[1] ?? '', ...args],
  });
  if (platform === 'win32') return new WindowsTaskServiceManager({ exec });
  if (platform === 'darwin') return new LaunchdServiceManager({ exec });
  return new SystemdServiceManager({ exec });
}

/** `<DATA_DIR>/logs` — where the api log sink writes `api-<stamp>.log` files. */
function defaultLogsDir(): string {
  return path.join(resolveDataDir(), 'logs');
}

/**
 * The newest `api-<stamp>.log` under `logsDir`, or null when there is none. The
 * stamp is an ISO timestamp, so the lexicographically LAST name is the newest —
 * no mtime needed. Exported for `service debug` tests.
 */
export function latestApiLogPath(
  logsDir: string,
  listDir: (dir: string) => string[] = (dir) => fs.readdirSync(dir)
): string | null {
  try {
    const names = listDir(logsDir)
      .filter((name) => /^api-.*\.log$/.test(name))
      .sort();
    const newest = names[names.length - 1];
    return newest ? path.join(logsDir, newest) : null;
  } catch {
    return null;
  }
}

/**
 * Last `n` lines of `filePath` (reading at most {@link TAIL_READ_BYTES} back
 * from the end), or null when the file is missing/unreadable. Exported for
 * `service debug` tests.
 */
export function tailFile(filePath: string, n: number): string[] | null {
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop(); // trailing newline
      return lines.slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * `tail -f` over the paths `resolvePaths()` yields, re-resolved every poll (so a
 * daemon restart's NEW `api-<stamp>.log` is picked up mid-follow). Starts at each
 * file's current EOF — the one-shot dump already printed the history; a file
 * first seen mid-follow (rotation) is emitted from its beginning. Runs until
 * `shouldContinue` says stop (default: forever — the operator Ctrl-Cs out).
 *
 * Byte-faithful, like real `tail -f`: a per-file **carry buffer** holds the bytes
 * after the last newline, so a line whose bytes arrive across two polls (a writer
 * that flushed mid-line — routine for Windows Out-File) is emitted ONCE, whole,
 * and never torn; a multi-byte UTF-8 char split at a read boundary is never
 * decoded half-way. On truncation (`size < prev`, e.g. the operator `>`-clears
 * the log while following) the cursor resets to **0** so the fresh content is
 * shown from the start (tail -F semantics) instead of being skipped.
 */
export async function followLogs(options: {
  resolvePaths: () => string[];
  out: (line: string) => void;
  pollMs?: number;
  shouldContinue?: () => boolean;
}): Promise<void> {
  const pollMs = options.pollMs ?? 500;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const positions = new Map<string, number>();
  const carry = new Map<string, Buffer>();
  for (const p of options.resolvePaths()) {
    try {
      positions.set(p, fs.statSync(p).size);
    } catch {
      // Not there yet — first appearance emits from byte 0.
    }
  }
  /** Emit whole lines from `carry + delta`, keeping the trailing partial as carry. */
  const drain = (p: string, delta: Buffer) => {
    const buf = carry.has(p) ? Buffer.concat([carry.get(p)!, delta]) : delta;
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) >= 0) {
      // Slice one line [start, nl); strip a trailing CR (Windows CRLF logs).
      let end = nl;
      if (end > start && buf[end - 1] === 0x0d) end -= 1;
      options.out(buf.toString('utf8', start, end));
      start = nl + 1;
    }
    // Remaining bytes after the last '\n' are an incomplete line — carry them.
    carry.set(p, start < buf.length ? buf.subarray(start) : Buffer.alloc(0));
  };
  while (shouldContinue()) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    for (const p of options.resolvePaths()) {
      try {
        const size = fs.statSync(p).size;
        let prev = positions.get(p) ?? 0;
        if (size < prev) {
          // Truncated/rotated in place — restart from the top so the fresh
          // content the operator cleared the file to see isn't lost.
          prev = 0;
          carry.delete(p);
        }
        if (size === prev) continue;
        const fd = fs.openSync(p, 'r');
        try {
          const buf = Buffer.alloc(size - prev);
          fs.readSync(fd, buf, 0, buf.length, prev);
          drain(p, buf);
        } finally {
          fs.closeSync(fd);
        }
        positions.set(p, size);
      } catch {
        // File missing/unreadable this tick — retry next poll.
      }
    }
  }
}

function formatStatus(status: ServiceStatus): string[] {
  const yesNo = (v: boolean | null) => (v === null ? 'n/a' : v ? 'yes' : 'no');
  return [
    `  installed:       ${yesNo(status.installed)}`,
    `  start at boot:   ${yesNo(status.enabled)}`,
    `  service active:  ${yesNo(status.active)}`,
    `  runtime healthy: ${yesNo(status.runtimeHealthy)} (loopback /api/health)`,
  ];
}

/**
 * Run `portable service <action>`. Returns the process exit code (0 = ok; for
 * `status`, 0 = daemon healthy, 1 = not running/not installed).
 */
export async function runServiceCommand(
  args: string[],
  deps: ServiceCommandsDeps = {}
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));

  // `service` is the command; the action is the NEXT non-flag positional.
  const positionals = args.filter((a) => !a.startsWith('-'));
  const action = positionals[positionals.indexOf('service') + 1];
  if (!action || !(ACTIONS as readonly string[]).includes(action)) {
    out(SERVICE_USAGE);
    return 1;
  }

  if (platform !== 'linux' && platform !== 'win32' && platform !== 'darwin') {
    out(
      'portable service is supported on Windows, Linux, and macOS only (portable.dev#12). ' +
        'On other platforms, run `portable` in a terminal.'
    );
    return 1;
  }

  const manager = (deps.makeManager ?? makeManagerReal)(platform, args);
  // Best-effort persistence of the cwd-independent install manifest (PRD §5) and
  // its removal on uninstall — seamed so tests never touch the real DATA_DIR.
  const persistManifest =
    deps.persistManifest ??
    (() => {
      try {
        persistServiceInstallManifest();
      } catch {
        // Never fail an install because the manifest could not be written.
      }
    });
  const clearInstallArtifacts =
    deps.clearInstallArtifacts ??
    (() => {
      try {
        removeServiceInstallManifest();
        new DaemonRuntimeStateStore().clear();
      } catch {
        // Best-effort cleanup.
      }
    });
  const captureCodexEnvironment =
    deps.captureCodexEnvironment ?? (() => captureServiceCodexEnvironment());
  const clearCodexEnvironment =
    deps.clearCodexEnvironment ?? (() => void deleteServiceCodexEnvironment());
  try {
    switch (action as ServiceAction) {
      case 'install':
        // Must happen before install(): every platform's fused install starts the
        // service immediately, and the daemon needs this snapshot at its boot.
        captureCodexEnvironment();
        await manager.install();
        persistManifest();
        out('portable service: installed and running.');
        out('Pair your phone by running `portable` interactively if you have not yet.');
        return 0;
      case 'uninstall':
        await manager.uninstall();
        {
          let cleanupFailed = false;
          try {
            clearCodexEnvironment();
          } catch {
            cleanupFailed = true;
          }
          try {
            clearInstallArtifacts();
          } catch {
            cleanupFailed = true;
          }
          if (cleanupFailed) {
            out(
              'portable service: service was removed, but local cleanup failed; ' +
                'the encrypted Codex environment snapshot may remain.'
            );
            return 1;
          }
        }
        out('portable service: uninstalled.');
        return 0;
      case 'start':
        captureCodexEnvironment();
        await manager.start();
        out('portable service: started.');
        return 0;
      case 'stop':
        await manager.stop();
        out('portable service: stopped.');
        return 0;
      case 'restart':
        // Stop then start — the managers serialize this; no singleton contention.
        captureCodexEnvironment();
        await manager.stop();
        await manager.start();
        out('portable service: restarted.');
        return 0;
      case 'status': {
        const status = await manager.status();
        out('portable service status:');
        for (const line of formatStatus(status)) out(line);
        const healthy = status.runtimeHealthy === true;
        if (!healthy && status.installed) {
          out('  logs: run `portable service debug` to see why.');
        }
        return healthy ? 0 : 1;
      }
      case 'debug': {
        const status = await manager.status();
        out('portable service status:');
        for (const line of formatStatus(status)) out(line);

        const daemonLog = deps.daemonLogPath ?? defaultDaemonLogPath();
        const logsDir = deps.logsDir ?? defaultLogsDir();
        if (platform === 'linux') {
          out('');
          out('  daemon journal: journalctl --user -u portable.service -e');
          out('  (early-boot errors — before the log file opens — only land there)');
        }

        // One-shot dump: the daemon sink (launcher + early-boot errors; macOS +
        // Windows) and the newest api log (all platforms).
        const dumps: Array<{ label: string; p: string | null }> = [
          ...(platform === 'linux' ? [] : [{ label: 'daemon log', p: daemonLog as string | null }]),
          { label: 'api log (newest)', p: latestApiLogPath(logsDir) },
        ];
        for (const { label, p } of dumps) {
          const lines = p ? tailFile(p, DEBUG_TAIL_LINES) : null;
          out('');
          if (!p || lines === null) {
            out(`--- ${label}: none found${p ? ` (${p})` : ''} ---`);
            continue;
          }
          out(`--- ${label}: ${p} (last ${lines.length} lines) ---`);
          for (const line of lines) out(line);
        }

        if (args.includes('--no-follow')) return 0;
        out('');
        out('--- following (Ctrl-C to exit) ---');
        // Follow ONE source per platform to avoid duplicate lines: the daemon
        // sink already contains the api output on macOS/Windows; on Linux that
        // sink does not exist (journald), so follow the newest api log instead.
        const resolvePaths =
          platform === 'linux'
            ? () => [latestApiLogPath(logsDir)].filter((p): p is string => p !== null)
            : () => [daemonLog];
        await (deps.followImpl ?? followLogs)({ resolvePaths, out });
        return 0;
      }
    }
  } catch (err) {
    out(`portable service ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return 1; // unreachable — every action above returns
}
