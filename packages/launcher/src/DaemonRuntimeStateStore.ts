/**
 * DaemonRuntimeStateStore — the launcher's structured, cross-process record of
 * what the SUPERVISED daemon (`portable connect --service`, portable.dev#12) is
 * doing right now (PRD §7).
 *
 * A manual `portable` — or the Service Dashboard — is a SEPARATE process from the
 * running daemon; the only things they share are `DATA_DIR` and the api over
 * loopback. `manager.status()` + `/api/health` answer "installed / active /
 * healthy", but they cannot see the daemon's tunnel provider, its public tunnel
 * URL, or whether the relay registration is confirmed. The daemon writes that
 * here at each boot milestone so a dashboard can render it without a second api
 * call.
 *
 * Like {@link PairingStateStore}/{@link DevicePresenceStore} this is PLAIN JSON at
 * `<DATA_DIR>/daemon-runtime-state.json`, written atomically (tmp→rename) with
 * restrictive perms, every op best-effort (never blocks the daemon). It holds
 * ONLY status — NEVER a secret or a QR payload (PRD §7). A STALE file must never
 * alone declare the service healthy: readers cross-check the live `/api/health`
 * and the recorded pid (PRD §4).
 */
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

import type { TunnelProvider } from './config.js';

/** Bumped when the shape changes incompatibly (an unknown version reads as absent). */
export const DAEMON_RUNTIME_STATE_SCHEMA_VERSION = 1;

/** `<DATA_DIR>/daemon-runtime-state.json`. */
export const DAEMON_RUNTIME_STATE_FILE = 'daemon-runtime-state.json';

/** The daemon's live phase across its lifecycle. */
export type DaemonPhase = 'starting' | 'healthy' | 'degraded' | 'stopping';

/** The structured runtime state the daemon publishes (PRD §7). No secrets. */
export interface DaemonRuntimeState {
  schemaVersion: number;
  mode: 'service';
  phase: DaemonPhase;
  /** The daemon process pid (readers verify it is still alive before trusting the file). */
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** The per-PC relay endpoint (`<relay>/t/<pcId>`). */
  endpoint: string;
  apiHealthy: boolean;
  tunnelProvider: TunnelProvider;
  /** `null` until the tunnel health monitor has an opinion. */
  tunnelHealthy: boolean | null;
  publicTunnelUrl?: string;
  /** `null` until the first registration handoff settles. */
  relayRegistered: boolean | null;
  lastRegisteredAt?: string;
  lastError?: string;
}

/** The keys serialized — the structural guard against ever persisting a secret (§7). */
const STATE_KEYS: ReadonlyArray<keyof DaemonRuntimeState> = [
  'schemaVersion',
  'mode',
  'phase',
  'pid',
  'startedAt',
  'updatedAt',
  'endpoint',
  'apiHealthy',
  'tunnelProvider',
  'tunnelHealthy',
  'publicTunnelUrl',
  'relayRegistered',
  'lastRegisteredAt',
  'lastError',
];

export interface DaemonRuntimeStateStoreOptions {
  /** Override the data directory (otherwise {@link resolveDataDir}). */
  dataDir?: string;
  /** Clock seam (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * The narrow write surface the launcher uses at boot milestones (PRD §7). A
 * best-effort adapter over {@link DaemonRuntimeStateStore.patch} that already
 * carries the immutable seed, so `boot()`/`shutdown()` just record status.
 */
export interface DaemonRuntimeStateWriter {
  patch(partial: Partial<DaemonRuntimeState>): void;
  clear(): void;
}

/** Reads/writes `<DATA_DIR>/daemon-runtime-state.json`. Side-effect-free to construct. */
export class DaemonRuntimeStateStore {
  readonly filePath: string;
  private readonly dataDir: string;
  private readonly now: () => Date;

  constructor(options: DaemonRuntimeStateStoreOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.filePath = path.join(this.dataDir, DAEMON_RUNTIME_STATE_FILE);
    this.now = options.now ?? (() => new Date());
  }

  /** Read the state. Never throws — missing/corrupt/unknown-version yields `null`. */
  read(): DaemonRuntimeState | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const c = parsed as Partial<DaemonRuntimeState>;
    if (c.schemaVersion !== DAEMON_RUNTIME_STATE_SCHEMA_VERSION) return null;
    if (typeof c.pid !== 'number' || typeof c.phase !== 'string') return null;
    return c as DaemonRuntimeState;
  }

  /** Overwrite the full state (stamps `updatedAt`). Best-effort — swallows fs errors. */
  write(state: DaemonRuntimeState): DaemonRuntimeState {
    const next: DaemonRuntimeState = { ...state, updatedAt: this.now().toISOString() };
    const projected: Partial<DaemonRuntimeState> = {};
    for (const key of STATE_KEYS) {
      const value = next[key];
      if (value !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (projected as any)[key] = value;
      }
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(projected, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Observability is best-effort — never block the daemon on persistence.
    }
    return next;
  }

  /**
   * Merge a partial update onto the current state (or, when no file exists yet,
   * onto `seed`) and persist it. Returns the merged state. `seed` supplies the
   * immutable fields (mode, pid, startedAt, endpoint, tunnelProvider) on the
   * FIRST write; subsequent patches carry them forward.
   */
  patch(
    partial: Partial<DaemonRuntimeState>,
    seed?: Pick<DaemonRuntimeState, 'pid' | 'startedAt' | 'endpoint' | 'tunnelProvider'>
  ): DaemonRuntimeState {
    const current = this.read();
    const base: DaemonRuntimeState = current ?? {
      schemaVersion: DAEMON_RUNTIME_STATE_SCHEMA_VERSION,
      mode: 'service',
      phase: 'starting',
      pid: seed?.pid ?? process.pid,
      startedAt: seed?.startedAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      endpoint: seed?.endpoint ?? '',
      apiHealthy: false,
      tunnelProvider: seed?.tunnelProvider ?? 'cloudflare',
      tunnelHealthy: null,
      relayRegistered: null,
    };
    return this.write({ ...base, ...partial, schemaVersion: DAEMON_RUNTIME_STATE_SCHEMA_VERSION });
  }

  /** Best-effort removal (on clean uninstall). Never throws. */
  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
