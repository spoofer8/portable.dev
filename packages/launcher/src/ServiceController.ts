/**
 * ServiceController — the reusable control plane over the background daemon
 * (portable.dev#12, PRD §4/§6).
 *
 * Today the `portable service <action>` commands each delegate straight to a
 * per-platform {@link ServiceManager} and print a string. The interactive Service
 * Dashboard needs richer, structured answers ("installed vs enabled vs supervisor
 * active vs runtime actually healthy", devices, tunnel, relay, uptime) AND actions
 * that WAIT for the real transition before claiming success. This controller is
 * that shared layer — it aggregates the platform manager, the live `/api/health`,
 * and the cross-process stores ({@link DevicePresenceStore},
 * {@link PairingStateStore}, {@link DaemonRuntimeStateStore},
 * {@link ServiceInstallManifest}) into a {@link ServiceSnapshot}, and drives the
 * lifecycle actions returning a structured {@link ServiceActionResult}.
 *
 * The dashboard NEVER shells out to the CLI or parses stdout (PRD §6); it calls
 * this. The platform managers stay responsible only for the platform mechanics.
 *
 * A STALE runtime-state / presence file must never on its own declare the service
 * healthy (PRD §4): the authoritative signals are the supervisor state
 * (`manager.status()`) and the live loopback `/api/health`. When the api is not
 * actually answering, this controller marks the snapshot `stale`, drops the
 * (necessarily dead) device list, and does not trust the file's tunnel/relay
 * "healthy" bits.
 */
import { DevicePresenceStore, PairingStateStore, resolveDataDir } from '@vgit2/shared/secrets';

import { type ApiHealthBody } from './ApiProcess.js';
import { LOCAL_BIND_HOST, resolveApiPort, type TunnelProvider } from './config.js';
import {
  DaemonRuntimeStateStore,
  type DaemonPhase,
  type DaemonRuntimeState,
} from './DaemonRuntimeStateStore.js';
import {
  persistServiceInstallManifest,
  readServiceInstallManifest,
  removeServiceInstallManifest,
  type ServiceInstallManifest,
} from './ServiceInstallManifest.js';
import {
  captureServiceCodexEnvironment,
  deleteServiceCodexEnvironment,
} from './ServiceCodexEnvironment.js';

import type { ServiceManager } from './ServiceManager.js';

/** One connected mobile device in the snapshot (a projection of DeviceInfo). */
export interface SnapshotDevice {
  name?: string;
  appVersion?: string;
  connectedAt: string;
}

/**
 * The structured, single-read view of the service (PRD §4). A strict superset of
 * {@link ServiceStatus}: it distinguishes "installed" from "enabled" from
 * "supervisor active" from "the runtime is actually serving", and adds uptime,
 * phase, tunnel, relay, connected devices, and last connection.
 */
export interface ServiceSnapshot {
  /** Is the service definition registered (unit / plist / task)? */
  installed: boolean;
  /** Is it enabled to auto-start? `null` when the platform can't tell. */
  enabled: boolean | null;
  /** Is the supervisor reporting it active? `null` on Windows (no locale-safe query). */
  supervisorActive: boolean | null;
  /** Is the runtime actually serving loopback `/api/health` right now? */
  runtimeHealthy: boolean;
  /** The daemon pid (from the runtime-state file), when known + still alive. */
  pid?: number;
  /** Api uptime in seconds (from the live health body), when healthy. */
  uptimeSeconds?: number;
  /** The daemon's self-reported phase (only trusted while healthy). */
  phase?: DaemonPhase;
  tunnel?: {
    provider: TunnelProvider;
    healthy: boolean | null;
    publicUrl?: string;
  };
  relay?: {
    endpoint: string;
    registered: boolean | null;
    lastRegisteredAt?: string;
  };
  /** Currently-connected mobile devices (empty when the runtime is not healthy). */
  devices: SnapshotDevice[];
  /** ISO timestamp of the most recent device connection ever observed. */
  lastConnectedAt?: string;
  /** The daemon's last recorded error, if any. */
  lastError?: string;
  /** When the runtime-state file was last written. */
  updatedAt?: string;
  /** True when a runtime-state file exists but is NOT backed by a live healthy runtime. */
  stale: boolean;
}

/** Result of a lifecycle action (PRD §6). `snapshot` is the state AFTER the action. */
export interface ServiceActionResult {
  ok: boolean;
  message: string;
  snapshot?: ServiceSnapshot;
  error?: string;
}

/** The reusable controller contract (PRD §6). */
export interface ServiceController {
  getSnapshot(): Promise<ServiceSnapshot>;
  install(options?: { start?: boolean }): Promise<ServiceActionResult>;
  uninstall(): Promise<ServiceActionResult>;
  start(): Promise<ServiceActionResult>;
  stop(): Promise<ServiceActionResult>;
  restart(): Promise<ServiceActionResult>;
}

/** Injected effects for {@link LauncherServiceController} (all defaulted in {@link createServiceController}). */
export interface ServiceControllerDeps {
  /** The per-platform manager (systemd / launchd / Task Scheduler). */
  manager: ServiceManager;
  /** Env for port/data-dir resolution (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** The data dir the daemon lives under (defaults to {@link resolveDataDir}). */
  dataDir?: string;
  /** Live health fetch → the body when `/api/health` says ok, else null. */
  fetchHealth?: (baseUrl: string) => Promise<ApiHealthBody | null>;
  /** Poll until the api is healthy (bounded); resolves true when it came up. */
  waitForHealthy?: (baseUrl: string) => Promise<boolean>;
  /** Poll until the api stops answering (bounded); resolves true when it went down. */
  waitForStopped?: (baseUrl: string) => Promise<boolean>;
  /** Read the live device presence (defaults to {@link DevicePresenceStore}). */
  readDevicePresence?: () => SnapshotDevice[];
  /** Read the last-connection marker (defaults to {@link PairingStateStore}). */
  readLastConnectedAt?: () => string | undefined;
  /** Read the daemon runtime state (defaults to {@link DaemonRuntimeStateStore}). */
  readRuntimeState?: () => DaemonRuntimeState | null;
  /** Read the install manifest (defaults to {@link readServiceInstallManifest}). */
  readManifest?: () => ServiceInstallManifest | null;
  /** Is `pid` a live process? Defaults to a real `kill(pid, 0)` probe. */
  isProcessAlive?: (pid: number) => boolean;
  /** Persist the install manifest on a successful install (defaults to the real writer). */
  persistManifest?: () => void;
  /** Remove the manifest + runtime-state on uninstall (defaults to the real remover). */
  clearInstallArtifacts?: () => void;
  /** Replace the encrypted service Codex env snapshot before install can start it. */
  captureCodexEnvironment?: () => void;
  /** Remove only the encrypted service Codex env snapshot on uninstall. */
  clearCodexEnvironment?: () => void;
  /**
   * The interactive runtime→daemon HANDOFF (PRD §10). Provided ONLY when the
   * dashboard runs inside a LIVE manual `portable` runtime (the connected menu):
   * it tears down THAT runtime's api/tunnel/pairing and frees the loopback port —
   * WITHOUT killing this CLI — so the supervised daemon can bind it. When present,
   * `install({start})`/`start()` register+enable the definition, run the handoff,
   * and only THEN start the service. Absent for the standalone dashboard (no
   * manual runtime), where install/start bind the port directly.
   */
  handoff?: () => Promise<void>;
  /** Log sink (defaults to a no-op — this is a library). */
  log?: (line: string) => void;
}

/** `kill(pid, 0)` liveness probe (EPERM = alive-but-not-ours, ESRCH = gone). */
function isProcessAliveReal(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Default health fetch: GET `/api/health`, body when ok + `status:'ok'`, else null. */
async function fetchHealthReal(baseUrl: string): Promise<ApiHealthBody | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ApiHealthBody;
    return body && body.status === 'ok' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `predicate` up to `attempts` times, `intervalMs` apart. True when it holds. */
async function pollUntil(
  predicate: () => Promise<boolean>,
  attempts: number,
  intervalMs: number
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export class LauncherServiceController implements ServiceController {
  private readonly manager: ServiceManager;
  private readonly env: NodeJS.ProcessEnv;
  private readonly dataDir: string;
  private readonly fetchHealth: (baseUrl: string) => Promise<ApiHealthBody | null>;
  private readonly waitForHealthyImpl: (baseUrl: string) => Promise<boolean>;
  private readonly waitForStoppedImpl: (baseUrl: string) => Promise<boolean>;
  private readonly readDevicePresence: () => SnapshotDevice[];
  private readonly readLastConnectedAt: () => string | undefined;
  private readonly readRuntimeState: () => DaemonRuntimeState | null;
  private readonly readManifest: () => ServiceInstallManifest | null;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly persistManifest: () => void;
  private readonly clearInstallArtifacts: () => void;
  private readonly captureCodexEnvironment: () => void;
  private readonly clearCodexEnvironment: () => void;
  private readonly handoff?: () => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(deps: ServiceControllerDeps) {
    this.manager = deps.manager;
    this.env = deps.env ?? process.env;
    this.dataDir = resolveDataDir(deps.dataDir);
    this.fetchHealth = deps.fetchHealth ?? fetchHealthReal;
    this.waitForHealthyImpl =
      deps.waitForHealthy ??
      ((baseUrl) => pollUntil(async () => (await this.fetchHealth(baseUrl)) !== null, 30, 500));
    this.waitForStoppedImpl =
      deps.waitForStopped ??
      ((baseUrl) => pollUntil(async () => (await this.fetchHealth(baseUrl)) === null, 24, 500));
    this.readDevicePresence =
      deps.readDevicePresence ??
      (() =>
        new DevicePresenceStore({ dataDir: this.dataDir }).read().devices.map((d) => ({
          name: d.name,
          appVersion: d.appVersion,
          connectedAt: d.connectedAt,
        })));
    this.readLastConnectedAt =
      deps.readLastConnectedAt ??
      (() => new PairingStateStore({ dataDir: this.dataDir }).read().lastConnectedAt);
    this.readRuntimeState =
      deps.readRuntimeState ??
      (() => new DaemonRuntimeStateStore({ dataDir: this.dataDir }).read());
    this.readManifest = deps.readManifest ?? (() => safeReadManifest(this.dataDir));
    this.isProcessAlive = deps.isProcessAlive ?? isProcessAliveReal;
    this.persistManifest =
      deps.persistManifest ?? (() => void persistServiceInstallManifest({ env: this.env }));
    this.clearInstallArtifacts =
      deps.clearInstallArtifacts ??
      (() => {
        removeServiceInstallManifest(this.dataDir);
        new DaemonRuntimeStateStore({ dataDir: this.dataDir }).clear();
      });
    this.captureCodexEnvironment =
      deps.captureCodexEnvironment ??
      (() => captureServiceCodexEnvironment({ env: this.env, dataDir: this.dataDir }));
    this.clearCodexEnvironment =
      deps.clearCodexEnvironment ??
      (() => void deleteServiceCodexEnvironment({ env: this.env, dataDir: this.dataDir }));
    this.handoff = deps.handoff;
    this.log = deps.log ?? (() => {});
  }

  /** Register + enable the definition WITHOUT starting (falls back to the fused install). */
  private async installDefinitionOnly(): Promise<void> {
    if (this.manager.installDefinition) await this.manager.installDefinition();
    else await this.manager.install();
  }

  /** Best-effort manifest freeze — never fails the action (§5). */
  private tryPersistManifest(): void {
    try {
      this.persistManifest();
    } catch (err) {
      this.log(`[service] manifest write failed: ${errMsg(err)}`);
    }
  }

  /**
   * The loopback base URL to probe. Prefers the manifest's frozen api port so a
   * dashboard launched from ANOTHER cwd (a different ambient `VGIT_PORT`) still
   * probes the port the daemon actually serves (PRD §5). Falls back to the
   * ambient env when no manifest exists.
   */
  private resolveBaseUrl(manifest: ServiceInstallManifest | null): string {
    const port = manifest?.apiPort ?? resolveApiPort(this.env);
    return `http://${LOCAL_BIND_HOST}:${port}`;
  }

  async getSnapshot(): Promise<ServiceSnapshot> {
    const manifest = this.readManifest();
    const baseUrl = this.resolveBaseUrl(manifest);
    const [status, health] = await Promise.all([this.manager.status(), this.fetchHealth(baseUrl)]);
    const runtimeHealthy = health !== null;
    const runtime = this.readRuntimeState();

    const pid = runtime?.pid;
    const pidAlive = typeof pid === 'number' ? this.isProcessAlive(pid) : false;
    // A runtime-state file is stale when it exists but is NOT backed by a live,
    // healthy runtime (dead pid or api not answering). Its tunnel/relay "healthy"
    // bits then can't be trusted, and its device list is necessarily dead.
    const stale = runtime !== null && (!runtimeHealthy || !pidAlive);

    const manifestEndpoint =
      manifest !== null ? `${manifest.relayBaseUrl}/t/${manifest.pcId}` : undefined;
    const tunnelProvider: TunnelProvider | undefined =
      runtime?.tunnelProvider ?? manifest?.tunnelProvider;

    const snapshot: ServiceSnapshot = {
      installed: status.installed,
      enabled: status.enabled,
      supervisorActive: status.active,
      runtimeHealthy,
      pid: pidAlive ? pid : undefined,
      uptimeSeconds: runtimeHealthy ? health?.uptime : undefined,
      phase: runtimeHealthy ? (runtime?.phase ?? 'healthy') : undefined,
      // Only real, current connections — an api that isn't answering has none.
      devices: runtimeHealthy ? this.readDevicePresence() : [],
      lastConnectedAt: this.readLastConnectedAt(),
      lastError: runtime?.lastError,
      updatedAt: runtime?.updatedAt,
      stale,
    };

    if (tunnelProvider) {
      snapshot.tunnel = {
        provider: tunnelProvider,
        healthy: runtimeHealthy ? (runtime?.tunnelHealthy ?? null) : null,
        publicUrl: runtime?.publicTunnelUrl,
      };
    }
    const relayEndpoint = runtime?.endpoint || manifestEndpoint;
    if (relayEndpoint) {
      snapshot.relay = {
        endpoint: relayEndpoint,
        registered: runtimeHealthy ? (runtime?.relayRegistered ?? null) : null,
        lastRegisteredAt: runtime?.lastRegisteredAt,
      };
    }
    return snapshot;
  }

  async install(options: { start?: boolean } = {}): Promise<ServiceActionResult> {
    const start = options.start ?? true;
    try {
      this.captureCodexEnvironment();
      if (!start) {
        await this.installDefinitionOnly();
        this.tryPersistManifest();
        return this.result(true, 'Service definition installed and enabled (not started).');
      }
      if (this.handoff) {
        // §10 interactive handoff: register + enable WITHOUT starting, freeze the
        // manifest, tear down the local manual runtime (freeing the port) WITHOUT
        // killing this CLI, then start the supervised daemon.
        await this.installDefinitionOnly();
        this.tryPersistManifest();
        await this.handoff();
        await this.manager.start();
      } else {
        // Standalone (no manual runtime): the fused register + enable + start.
        await this.manager.install();
        this.tryPersistManifest();
      }
      const healthy = await this.waitForHealthyImpl(this.resolveBaseUrl(this.readManifest()));
      return this.result(
        healthy,
        healthy
          ? 'Service installed and running.'
          : 'Service installed, but the runtime has not become healthy yet.'
      );
    } catch (err) {
      return this.result(false, `Install failed: ${errMsg(err)}`, err);
    }
  }

  async uninstall(): Promise<ServiceActionResult> {
    try {
      await this.manager.uninstall();
      let codexCleanupFailed = false;
      let artifactCleanupFailed = false;
      try {
        this.clearCodexEnvironment();
      } catch {
        codexCleanupFailed = true;
        this.log('[service] encrypted Codex environment snapshot cleanup failed.');
      }
      try {
        this.clearInstallArtifacts();
      } catch {
        artifactCleanupFailed = true;
        this.log('[service] install artifact cleanup failed.');
      }
      if (codexCleanupFailed || artifactCleanupFailed) {
        const detail = [
          codexCleanupFailed ? 'encrypted Codex environment snapshot' : '',
          artifactCleanupFailed ? 'install artifacts' : '',
        ]
          .filter(Boolean)
          .join(' and ');
        const message = `The service was removed, but cleanup failed for ${detail}.`;
        return this.result(false, message, new Error(message));
      }
      return this.result(true, 'Service uninstalled.');
    } catch (err) {
      return this.result(false, `Uninstall failed: ${errMsg(err)}`, err);
    }
  }

  async start(): Promise<ServiceActionResult> {
    try {
      this.captureCodexEnvironment();
      // §10: if a live manual runtime owns the port, free it first (no-op/idempotent
      // when there is none) so the daemon can bind it.
      if (this.handoff) await this.handoff();
      await this.manager.start();
      const healthy = await this.waitForHealthyImpl(this.resolveBaseUrl(this.readManifest()));
      return this.result(
        healthy,
        healthy ? 'Service started.' : 'Started, but the runtime has not become healthy yet.'
      );
    } catch (err) {
      return this.result(false, `Start failed: ${errMsg(err)}`, err);
    }
  }

  async stop(): Promise<ServiceActionResult> {
    try {
      await this.manager.stop();
      const stopped = await this.waitForStoppedImpl(this.resolveBaseUrl(this.readManifest()));
      return this.result(
        stopped,
        stopped ? 'Service stopped.' : 'Stop requested, but the runtime is still answering.'
      );
    } catch (err) {
      return this.result(false, `Stop failed: ${errMsg(err)}`, err);
    }
  }

  async restart(): Promise<ServiceActionResult> {
    try {
      this.captureCodexEnvironment();
      const baseUrl = this.resolveBaseUrl(this.readManifest());
      await this.manager.stop();
      await this.waitForStoppedImpl(baseUrl);
      await this.manager.start();
      const healthy = await this.waitForHealthyImpl(baseUrl);
      return this.result(
        healthy,
        healthy ? 'Service restarted.' : 'Restarted, but the runtime has not become healthy yet.'
      );
    } catch (err) {
      return this.result(false, `Restart failed: ${errMsg(err)}`, err);
    }
  }

  /** Attach a fresh snapshot to the result (best-effort — never fails the action). */
  private async result(
    ok: boolean,
    message: string,
    error?: unknown
  ): Promise<ServiceActionResult> {
    let snapshot: ServiceSnapshot | undefined;
    try {
      snapshot = await this.getSnapshot();
    } catch {
      snapshot = undefined;
    }
    return { ok, message, snapshot, ...(error ? { error: errMsg(error) } : {}) };
  }
}

/** {@link readServiceInstallManifest} that folds a version mismatch into `null` for the snapshot path. */
function safeReadManifest(dataDir: string): ServiceInstallManifest | null {
  try {
    return readServiceInstallManifest(dataDir);
  } catch {
    // A version-mismatch throw is surfaced by the routing layer, not the snapshot.
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wire a controller with the real stores + health probe for `manager`. */
export function createServiceController(
  manager: ServiceManager,
  options: {
    env?: NodeJS.ProcessEnv;
    dataDir?: string;
    log?: (line: string) => void;
    /** The interactive runtime→daemon handoff (PRD §10) — see {@link ServiceControllerDeps.handoff}. */
    handoff?: () => Promise<void>;
  } = {}
): LauncherServiceController {
  return new LauncherServiceController({ manager, ...options });
}
