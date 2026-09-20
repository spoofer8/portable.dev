/**
 * ServiceInstallManifest — a stable, per-user, **cwd-independent** record of how
 * the background daemon (`portable service install`, portable.dev#12) was
 * installed (PRD §5, tasks/prd-background-daemon-cli-surface.md).
 *
 * The daemon re-reads the operator's `.env` relative to the cwd
 * `portable service install` ran from (baked into {@link ServiceExecSpec.workingDirectory}).
 * That means an interactive `portable` — or the new Service Dashboard — launched
 * from ANOTHER directory cannot re-derive the SAME `pcId`, relay, api port,
 * tunnel provider, and `DATA_DIR` the daemon actually uses (those come from the
 * install cwd's `.env`, not the ambient one). This manifest freezes the resolved
 * install context at install time so the dashboard, run from any directory,
 * reconstructs the exact same effective configuration.
 *
 * The manifest holds ONLY routing/config — NEVER a secret. The JWT secret, the
 * pairing JWT, the E2E PSK, the Claude/GitHub tokens, and the service's allowlisted
 * Codex provider environment stay exclusively in encrypted {@link LocalSecretStore}
 * instances under {@link ServiceInstallManifest.dataDir} (the Codex snapshot uses
 * its own child store to avoid concurrent writes). The manifest is written atomically
 * with restrictive permissions (mirrors the
 * {@link PairingStateStore}/{@link DevicePresenceStore} write pattern).
 */
import fs from 'fs';
import path from 'path';

import { LocalSecretStore, resolveDataDir } from '@vgit2/shared/secrets';

import {
  resolveApiPort,
  resolveCliVersion,
  resolveRelayBaseUrl,
  resolveTunnelProvider,
  type TunnelProvider,
} from './config.js';
import { FORWARDED_FLAGS } from './ServiceManager.js';
import { resolvePcId, resolvePcLabel } from './TunnelRegistrationAgent.js';

/**
 * Bumped whenever the manifest's shape changes incompatibly. A manifest written
 * by an OLDER/NEWER schema must be rejected with reinstall/update guidance rather
 * than silently mis-read (PRD §12.2).
 */
export const SERVICE_MANIFEST_SCHEMA_VERSION = 1;

/** `<DATA_DIR>/service-install.json`. */
export const SERVICE_MANIFEST_FILE = 'service-install.json';

/** The install context frozen at `portable service install` time (PRD §5). No secrets. */
export interface ServiceInstallManifest {
  /** Schema version — {@link SERVICE_MANIFEST_SCHEMA_VERSION} at write time. */
  schemaVersion: number;
  /** ISO timestamp the manifest was written. */
  installedAt: string;
  /** The CLI version that performed the install ({@link resolveCliVersion}). */
  cliVersion: string;
  /** The platform the daemon was installed on. */
  platform: NodeJS.Platform;
  /** The cwd `portable service install` ran from (the daemon's `.env` root). */
  workingDirectory: string;
  /** The resolved data dir the daemon + its LocalSecretStore live under. */
  dataDir: string;
  /** The stable routing id (= the minted JWT's userId). */
  pcId: string;
  /** Human PC label. */
  pcLabel: string;
  /** The hosted relay base the daemon registers with. */
  relayBaseUrl: string;
  /** The loopback api port the daemon serves. */
  apiPort: number;
  /** The public tunnel provider the daemon uses. */
  tunnelProvider: TunnelProvider;
  /** The `portable service install` flags carried into the daemon (`--dev`, `--ngrok`). */
  forwardedFlags: string[];
}

/** The whitelist of keys serialized into the manifest — the guard against ever writing a secret. */
const MANIFEST_KEYS: ReadonlyArray<keyof ServiceInstallManifest> = [
  'schemaVersion',
  'installedAt',
  'cliVersion',
  'platform',
  'workingDirectory',
  'dataDir',
  'pcId',
  'pcLabel',
  'relayBaseUrl',
  'apiPort',
  'tunnelProvider',
  'forwardedFlags',
];

/** `<dataDir>/service-install.json` (dataDir defaults to {@link resolveDataDir}). */
export function defaultServiceManifestPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, SERVICE_MANIFEST_FILE);
}

/** Thrown by {@link readServiceInstallManifest} when the on-disk schema is incompatible. */
export class ServiceManifestVersionError extends Error {
  readonly foundVersion: number;
  constructor(foundVersion: number) {
    super(
      `The installed daemon's service manifest is version ${foundVersion}, but this CLI expects ` +
        `version ${SERVICE_MANIFEST_SCHEMA_VERSION}. Reinstall the service with ` +
        '`portable service install` (or update portable) to refresh it.'
    );
    this.name = 'ServiceManifestVersionError';
    this.foundVersion = foundVersion;
  }
}

/** Inputs for {@link buildServiceInstallManifest} (every effect is defaulted/seamed). */
export interface BuildServiceInstallManifestOptions {
  /** The shared secret store (for the stable pcId). */
  store: Pick<LocalSecretStore, 'get' | 'set'>;
  /** Env to resolve relay/port/tunnel/pcId/label from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** The cwd the install ran from (defaults to `process.cwd()`). */
  cwd?: string;
  /** The flags forwarded into the daemon invocation (`--dev`, `--ngrok`). */
  forwardedFlags?: string[];
  /** Install platform (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Clock seam (defaults to `new Date()`). */
  now?: Date;
  /** CLI version seam (defaults to {@link resolveCliVersion}). */
  cliVersion?: string;
  /** Data-dir seam (defaults to {@link resolveDataDir}). */
  dataDir?: string;
}

/**
 * Resolve the current install context into a {@link ServiceInstallManifest} —
 * the SAME resolvers the daemon uses at boot ({@link resolvePcId},
 * {@link resolvePcLabel}, {@link resolveRelayBaseUrl}, {@link resolveApiPort},
 * {@link resolveTunnelProvider}), captured once so a later CLI from any cwd
 * reconstructs it. Pure aside from the resolvers' reads; writes nothing.
 */
export function buildServiceInstallManifest(
  options: BuildServiceInstallManifestOptions
): ServiceInstallManifest {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const store = options.store as LocalSecretStore;
  return {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    installedAt: now.toISOString(),
    cliVersion: options.cliVersion ?? resolveCliVersion(),
    platform: options.platform ?? process.platform,
    workingDirectory: options.cwd ?? process.cwd(),
    dataDir: resolveDataDir(options.dataDir),
    pcId: resolvePcId(store, env),
    pcLabel: resolvePcLabel(env),
    relayBaseUrl: resolveRelayBaseUrl(env),
    apiPort: resolveApiPort(env),
    tunnelProvider: resolveTunnelProvider(env),
    forwardedFlags: [...(options.forwardedFlags ?? [])],
  };
}

/** Options for {@link writeServiceInstallManifest}. */
export interface WriteServiceInstallManifestOptions {
  /** Where to write (defaults to `<manifest.dataDir>/service-install.json`). */
  manifestPath?: string;
  /** fs write seam (tests). Defaults to the real atomic tmp→rename write. */
  writeImpl?: (p: string, content: string) => void;
}

/**
 * Serialize ONLY the whitelisted {@link MANIFEST_KEYS} (never an unexpected field
 * — the structural guard against leaking a secret, PRD §5/§12.2) and write them
 * atomically with restrictive permissions. Defaults to `<dataDir>/service-install.json`.
 */
export function writeServiceInstallManifest(
  manifest: ServiceInstallManifest,
  options: WriteServiceInstallManifestOptions = {}
): void {
  const target = options.manifestPath ?? defaultServiceManifestPath(manifest.dataDir);
  const projected: Partial<ServiceInstallManifest> = {};
  for (const key of MANIFEST_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (projected as any)[key] = manifest[key];
  }
  const content = JSON.stringify(projected, null, 2);
  if (options.writeImpl) {
    options.writeImpl(target, content);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Options for {@link readServiceInstallManifest}. */
export interface ReadServiceInstallManifestOptions {
  /** Explicit manifest path (otherwise `<dataDir>/service-install.json`). */
  manifestPath?: string;
  /** fs read seam (tests). Defaults to `fs.readFileSync`. */
  readImpl?: (p: string) => string;
}

/**
 * Read the manifest for the given `dataDir` (or explicit path). Returns `null`
 * when it is absent or unparseable (a fresh box / never-installed). Throws
 * {@link ServiceManifestVersionError} when a WELL-FORMED manifest carries an
 * incompatible `schemaVersion` — the caller surfaces reinstall/update guidance
 * (PRD §12.2) instead of trusting a shape it can't read.
 */
export function readServiceInstallManifest(
  dataDir: string = resolveDataDir(),
  options: ReadServiceInstallManifestOptions = {}
): ServiceInstallManifest | null {
  const target = options.manifestPath ?? defaultServiceManifestPath(dataDir);
  let raw: string;
  try {
    raw = options.readImpl ? options.readImpl(target) : fs.readFileSync(target, 'utf8');
  } catch {
    return null; // absent / unreadable → never installed here
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON → treat as absent (best-effort)
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<ServiceInstallManifest>;
  // A well-formed but version-mismatched manifest is a HARD error (reinstall),
  // distinct from a missing/corrupt one (null).
  if (typeof candidate.schemaVersion !== 'number') return null;
  if (candidate.schemaVersion !== SERVICE_MANIFEST_SCHEMA_VERSION) {
    throw new ServiceManifestVersionError(candidate.schemaVersion);
  }
  // Minimal shape sanity — the load-bearing routing fields must be present.
  if (
    typeof candidate.pcId !== 'string' ||
    typeof candidate.dataDir !== 'string' ||
    typeof candidate.relayBaseUrl !== 'string' ||
    typeof candidate.apiPort !== 'number'
  ) {
    return null;
  }
  return candidate as ServiceInstallManifest;
}

/** Best-effort removal of the manifest (on `service uninstall`). Never throws. */
export function removeServiceInstallManifest(
  dataDir: string = resolveDataDir(),
  removeImpl: (p: string) => void = (p) => fs.rmSync(p, { force: true })
): void {
  try {
    removeImpl(defaultServiceManifestPath(dataDir));
  } catch {
    /* best-effort */
  }
}

/** Inputs for {@link persistServiceInstallManifest} (all defaulted from the process). */
export interface PersistServiceInstallManifestOptions {
  /** The shared secret store (defaults to a fresh {@link LocalSecretStore}). */
  store?: Pick<LocalSecretStore, 'get' | 'set'>;
  /** Env to resolve from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** The install cwd (defaults to process.cwd()). */
  cwd?: string;
  /** The current argv — the forwarded daemon flags are derived from it. */
  argv?: string[];
  /** Install platform (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Clock seam. */
  now?: Date;
}

/**
 * Build AND write the {@link ServiceInstallManifest} from the current process
 * context in one call — used by BOTH the non-interactive `portable service
 * install` and the interactive dashboard install so a later CLI from any cwd
 * finds the frozen install context (PRD §5). The forwarded flags are derived
 * from argv the same way {@link resolveServiceExec} does. Returns the manifest.
 */
export function persistServiceInstallManifest(
  options: PersistServiceInstallManifestOptions = {}
): ServiceInstallManifest {
  const store = options.store ?? new LocalSecretStore();
  const argv = options.argv ?? process.argv;
  const forwardedFlags = FORWARDED_FLAGS.filter((flag) => argv.includes(flag));
  const manifest = buildServiceInstallManifest({
    store,
    env: options.env,
    cwd: options.cwd,
    forwardedFlags,
    platform: options.platform,
    now: options.now,
  });
  writeServiceInstallManifest(manifest);
  return manifest;
}
