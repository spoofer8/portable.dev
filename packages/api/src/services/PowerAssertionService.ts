import { spawn as spawnChildProcess } from 'child_process';

export interface PowerAssertionProcess {
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals) => boolean;
  once?: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => unknown;
}

export interface PowerAssertionServiceOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  idleGraceMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  spawn?: (command: string, args: string[]) => PowerAssertionProcess;
  kill?: (child: PowerAssertionProcess) => void;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;

/**
 * Keeps macOS out of idle sleep only while the local runtime has active work.
 * It deliberately uses `caffeinate -i`: display sleep and explicit system sleep
 * remain available, while a connected phone or running agent can finish work.
 */
export class PowerAssertionService {
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly idleGraceMs: number;
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private readonly spawnProcess: (command: string, args: string[]) => PowerAssertionProcess;
  private readonly killProcess: (child: PowerAssertionProcess) => void;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTimeout: (timer: unknown) => void;
  private readonly leases = new Map<string, number>();

  private assertionProcess?: PowerAssertionProcess;
  private releaseTimer?: unknown;
  private restartTimer?: unknown;
  private restartAttempts = 0;
  private stopped = false;

  constructor(options: PowerAssertionServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    this.spawnProcess =
      options.spawn ?? ((command, args) => spawnChildProcess(command, args, { stdio: 'ignore' }));
    this.killProcess =
      options.kill ??
      ((child) => {
        if (!child.killed) child.kill?.('SIGTERM');
      });
    this.scheduleTimeout =
      options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  /** Acquire one lease. The returned disposer releases this acquisition once. */
  acquire(reason: string): () => void {
    if (this.stopped || this.platform !== 'darwin') return () => {};
    if (!reason.trim()) throw new Error('Power assertion lease reason is required');

    this.cancelPendingRelease();
    this.leases.set(reason, (this.leases.get(reason) ?? 0) + 1);
    this.ensureAssertion();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(reason);
    };
  }

  /** Release one lease for a reason. Unknown reasons are harmless. */
  release(reason: string): void {
    if (this.stopped || this.platform !== 'darwin') return;

    const count = this.leases.get(reason);
    if (!count) return;
    if (count === 1) this.leases.delete(reason);
    else this.leases.set(reason, count - 1);

    if (this.activeLeaseCount() === 0) {
      this.cancelPendingRestart();
      this.restartAttempts = 0;
      this.scheduleRelease();
    }
  }

  /** Immediately removes the assertion, regardless of the idle grace. */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.leases.clear();
    this.cancelPendingRelease();
    this.cancelPendingRestart();
    this.stopAssertion();
  }

  private activeLeaseCount(): number {
    let total = 0;
    for (const count of this.leases.values()) total += count;
    return total;
  }

  private ensureAssertion(): void {
    if (this.assertionProcess || this.restartTimer !== undefined || this.activeLeaseCount() === 0) {
      return;
    }

    try {
      const child = this.spawnProcess('/usr/bin/caffeinate', ['-i', '-w', String(this.pid)]);
      this.assertionProcess = child;

      const forgetChild = () => {
        if (this.assertionProcess !== child) return;
        this.assertionProcess = undefined;
        if (!this.stopped && this.activeLeaseCount() > 0) this.scheduleRestart();
      };
      child.once?.('error', forgetChild);
      child.once?.('exit', forgetChild);
    } catch (error) {
      console.error('[PowerAssertion] Failed to start caffeinate:', error);
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.activeLeaseCount() === 0 || this.restartTimer !== undefined) return;

    const exponent = Math.min(this.restartAttempts, 30);
    const delayMs = Math.min(
      this.restartMaxDelayMs,
      this.restartBaseDelayMs * Math.pow(2, exponent)
    );
    this.restartAttempts += 1;

    const timer = this.scheduleTimeout(() => {
      if (this.restartTimer !== timer) return;
      this.restartTimer = undefined;
      this.ensureAssertion();
    }, delayMs);
    this.restartTimer = timer;
    (timer as { unref?: () => void }).unref?.();
  }

  private scheduleRelease(): void {
    if (!this.assertionProcess || this.releaseTimer !== undefined) return;
    if (this.idleGraceMs <= 0) {
      this.stopAssertion();
      return;
    }

    const timer = this.scheduleTimeout(() => {
      if (this.releaseTimer !== timer) return;
      this.releaseTimer = undefined;
      if (this.activeLeaseCount() === 0) this.stopAssertion();
    }, this.idleGraceMs);
    this.releaseTimer = timer;
    (timer as { unref?: () => void }).unref?.();
  }

  private cancelPendingRelease(): void {
    if (this.releaseTimer === undefined) return;
    this.cancelTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }

  private cancelPendingRestart(): void {
    if (this.restartTimer === undefined) return;
    this.cancelTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private stopAssertion(): void {
    const child = this.assertionProcess;
    this.assertionProcess = undefined;
    this.restartAttempts = 0;
    if (!child) return;

    try {
      this.killProcess(child);
    } catch (error) {
      console.error('[PowerAssertion] Failed to stop caffeinate:', error);
    }
  }
}
