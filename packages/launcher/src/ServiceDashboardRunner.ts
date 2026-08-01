/**
 * ServiceDashboardRunner — assemble + run the interactive Service Dashboard, and
 * the `portable` routing that opens it (PRD §3, §11).
 *
 * This is the seam between `cli.ts` and the dashboard: it builds the per-platform
 * {@link ServiceManager}, wraps it in a {@link ServiceController}, wires the
 * {@link PairingSessionFactory} (fresh QR, §8) and {@link ServiceLogSource}
 * (debug, §9), and mounts {@link startServiceDashboard}, resolving when the user
 * leaves. It NEVER boots a second api/tunnel (PRD §13) — the dashboard only reads
 * the live daemon over loopback and drives the platform managers.
 *
 * Routing ({@link runServiceDashboardIfInstalled}): a manual `portable` in front
 * of an INSTALLED service (running, stopped, or broken) opens the dashboard
 * instead of the singleton-takeover path — the state where the user most needs
 * Start / Debug / Uninstall (PRD §11). Detection keys on the supervisor-owned
 * signals (`installed` / `active`), NOT the health probe — a plain manual runtime
 * also answers `/api/health`, so health alone is not a "service exists" signal.
 */
import { resolveDataDir } from '@vgit2/shared/secrets';

import { PairingSessionFactory } from './PairingSessionFactory.js';
import { makeManagerReal } from './ServiceCommands.js';
import { createServiceController, type ServiceController } from './ServiceController.js';
import {
  startServiceDashboard,
  type DashboardDebugSource,
  type DashboardPairingSession,
  type ServiceDashboardHandle,
} from './ServiceDashboardUi.js';
import { readServiceInstallManifest } from './ServiceInstallManifest.js';
import { ServiceLogSource } from './ServiceLogSource.js';
import { resolvePcLabel } from './TunnelRegistrationAgent.js';

import type { ServiceManager } from './ServiceManager.js';

const SUPPORTED = new Set<NodeJS.Platform>(['linux', 'win32', 'darwin']);

export interface ServiceDashboardRunnerDeps {
  /** Platform switch (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Env (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Manager factory seam (defaults to the real per-platform managers). */
  makeManager?: (platform: NodeJS.Platform, args: string[]) => ServiceManager;
  /** Output sink (defaults to stdout). */
  out?: (line: string) => void;
  /** Is this an interactive terminal? (defaults to a real TTY check). */
  isInteractive?: () => boolean;
  /** Dashboard mount seam (tests). Defaults to {@link startServiceDashboard}. */
  startDashboard?: typeof startServiceDashboard;
  /** Controller factory seam (tests). Defaults to {@link createServiceController}. */
  makeController?: (manager: ServiceManager) => ServiceController;
  /** Fresh-pairing session seam (tests). Defaults to a real {@link PairingSessionFactory}. */
  pairing?: DashboardPairingSession;
  /** Debug log source seam (tests). Defaults to a real {@link ServiceLogSource}. */
  debug?: DashboardDebugSource;
  /** Log sink for the dashboard's own diagnostics (never a secret). */
  log?: (line: string) => void;
}

function defaultInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** The PC label for the dashboard header: the manifest's frozen label, else the ambient one. */
function resolveDashboardLabel(env: NodeJS.ProcessEnv): string {
  try {
    const manifest = readServiceInstallManifest(resolveDataDir());
    if (manifest?.pcLabel) return manifest.pcLabel;
  } catch {
    // version mismatch / unreadable — fall back to the ambient label
  }
  return resolvePcLabel(env);
}

/**
 * Is a background service INSTALLED (or supervisor-active) right now? Keys on the
 * platform manager's supervisor-owned signals, not the health probe. Never throws
 * — a platform without the supervisor (e.g. systemd-less WSL) resolves to `false`.
 */
export async function isServiceInstalled(
  args: string[],
  deps: ServiceDashboardRunnerDeps = {}
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (!SUPPORTED.has(platform)) return false;
  try {
    const manager = (deps.makeManager ?? makeManagerReal)(platform, args);
    const status = await manager.status();
    return status.installed === true || status.active === true;
  } catch {
    return false;
  }
}

/**
 * Build the controller + pairing + debug sources and run the dashboard to
 * completion (resolves when the user leaves it). Returns the process exit code.
 */
export async function runServiceDashboard(
  args: string[],
  deps: ServiceDashboardRunnerDeps = {}
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const isInteractive = deps.isInteractive ?? defaultInteractive;

  if (!SUPPORTED.has(platform)) {
    out(
      'The Service dashboard is supported on Windows, Linux, and macOS only. ' +
        'On other platforms, run `portable` in a terminal.'
    );
    return 1;
  }
  if (!isInteractive()) {
    // No TTY to drive an Ink dashboard — degrade to the scriptable status dump.
    const { runServiceCommand } = await import('./ServiceCommands.js');
    return runServiceCommand(['service', 'status'], {
      platform,
      out,
      makeManager: deps.makeManager,
    });
  }

  const manager = (deps.makeManager ?? makeManagerReal)(platform, args);
  const controller =
    deps.makeController?.(manager) ?? createServiceController(manager, { env, log: deps.log });
  const pairing = deps.pairing ?? new PairingSessionFactory({ env });
  const debug = deps.debug ?? new ServiceLogSource({ platform });
  const label = resolveDashboardLabel(env);
  const startDashboard = deps.startDashboard ?? startServiceDashboard;

  return await new Promise<number>((resolve) => {
    let handle: ServiceDashboardHandle | null = null;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      handle?.stop();
      void pairing.close().catch(() => {});
      resolve(code);
    };
    startDashboard({
      controller,
      label,
      onExit: () => finish(0),
      pairing,
      debug,
    })
      .then((h) => {
        handle = h;
      })
      .catch((err) => {
        out(
          `Failed to open the service dashboard: ${err instanceof Error ? err.message : String(err)}`
        );
        finish(1);
      });
  });
}

/**
 * Routing entry for a manual `portable` run: if a background service is installed
 * (or active), open the dashboard and resolve `true` (the CLI must NOT then boot a
 * runtime). Resolves `false` when nothing is installed → the caller proceeds with
 * the normal interactive boot (PRD §11).
 */
export async function runServiceDashboardIfInstalled(
  args: string[],
  deps: ServiceDashboardRunnerDeps = {}
): Promise<{ handled: boolean; code: number }> {
  if (!(await isServiceInstalled(args, deps))) return { handled: false, code: 0 };
  const code = await runServiceDashboard(args, deps);
  return { handled: true, code };
}
