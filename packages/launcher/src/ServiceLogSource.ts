/**
 * ServiceLogSource — the shared log-reading layer behind BOTH `portable service
 * debug` and the dashboard's interactive Debug screen (PRD §9).
 *
 * It composes the SAME primitives the non-interactive command already uses
 * ({@link latestApiLogPath}, {@link tailFile}, {@link followLogs}), so the two
 * consumers never drift. Per platform it follows ONE source to avoid duplicate
 * lines: on Linux the newest `api-<stamp>.log` (early-boot errors land in the
 * journal, which is not a readable file), and on macOS/Windows the daemon log
 * (which already contains the api output). Rotation is handled by re-resolving
 * the path each poll ({@link followLogs}); the follow is bounded by a stop flag so
 * leaving the screen releases it (PRD §9).
 *
 * It implements {@link DashboardDebugSource}, so it plugs straight into
 * {@link startServiceDashboard}.
 */
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

import { followLogs, latestApiLogPath, tailFile } from './ServiceCommands.js';
import { defaultDaemonLogPath } from './ServiceManager.js';

import type { DashboardDebugSource } from './ServiceDashboardUi.js';

/** A live follow subscription — `stop()` releases the poll loop. */
export interface ServiceLogSubscription {
  stop(): void;
}

export interface ServiceLogSourceDeps {
  /** Platform switch (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** The daemon log path (macOS/Windows sink). Defaults to {@link defaultDaemonLogPath}. */
  daemonLogPath?: string;
  /** The api-log dir. Defaults to `<DATA_DIR>/logs`. */
  logsDir?: string;
  /** Tail seam (defaults to {@link tailFile}). */
  tailFileImpl?: typeof tailFile;
  /** Newest-api-log seam (defaults to {@link latestApiLogPath}). */
  latestApiLogPathImpl?: typeof latestApiLogPath;
  /** Follow-loop seam (defaults to {@link followLogs}). */
  followImpl?: typeof followLogs;
  /** Poll interval for the follow loop (ms). */
  followPollMs?: number;
}

export class ServiceLogSource implements DashboardDebugSource {
  private readonly platform: NodeJS.Platform;
  private readonly daemonLogPath: string;
  private readonly logsDir: string;
  private readonly tailFileImpl: typeof tailFile;
  private readonly latestApiLogPathImpl: typeof latestApiLogPath;
  private readonly followImpl: typeof followLogs;
  private readonly followPollMs?: number;

  constructor(deps: ServiceLogSourceDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.daemonLogPath = deps.daemonLogPath ?? defaultDaemonLogPath();
    this.logsDir = deps.logsDir ?? path.join(resolveDataDir(), 'logs');
    this.tailFileImpl = deps.tailFileImpl ?? tailFile;
    this.latestApiLogPathImpl = deps.latestApiLogPathImpl ?? latestApiLogPath;
    this.followImpl = deps.followImpl ?? followLogs;
    this.followPollMs = deps.followPollMs;
  }

  /** The single log source to read/follow for this platform (re-resolved each call). */
  private resolvePaths(): string[] {
    if (this.platform === 'linux') {
      const newest = this.latestApiLogPathImpl(this.logsDir);
      return newest ? [newest] : [];
    }
    return [this.daemonLogPath];
  }

  /** Diagnostic header lines shown above the live log (config + log paths). */
  meta(): string[] {
    const newestApi = this.latestApiLogPathImpl(this.logsDir);
    if (this.platform === 'linux') {
      return [
        'Journal:  journalctl --user -u portable.service -e',
        `API log:  ${newestApi ?? '(none yet)'}`,
      ];
    }
    return [`Daemon log: ${this.daemonLogPath}`, `API log:    ${newestApi ?? '(none yet)'}`];
  }

  /** The most recent `limit` lines from the platform's log source. */
  async readRecent(limit: number): Promise<string[]> {
    const lines: string[] = [];
    for (const p of this.resolvePaths()) {
      const tail = this.tailFileImpl(p, limit);
      if (tail) lines.push(...tail);
    }
    return lines.slice(-limit);
  }

  /** Follow appended lines live; the returned handle stops the poll loop (PRD §9). */
  follow(onLine: (line: string) => void): ServiceLogSubscription {
    let stopped = false;
    // followLogs resolves when shouldContinue() goes false; we let it run detached.
    void this.followImpl({
      resolvePaths: () => this.resolvePaths(),
      out: (line) => {
        if (!stopped) onLine(line);
      },
      ...(this.followPollMs ? { pollMs: this.followPollMs } : {}),
      shouldContinue: () => !stopped,
    });
    return {
      stop: () => {
        stopped = true;
      },
    };
  }
}
