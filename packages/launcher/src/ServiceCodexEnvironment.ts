import path from 'path';

import {
  isCodexEnvAllowed,
  parseCodexEnvAllowlist,
  selectCodexProcessEnv,
} from '@vgit2/shared/codexEnv';
import { LocalSecretStore, resolveDataDir } from '@vgit2/shared/secrets';

export const SERVICE_CODEX_ENV_SECRET_KEY = 'launcher:service-codex-env:v1';
export const SERVICE_CODEX_ENV_STORE_DIRECTORY = 'service-codex-env';

interface SecretStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): boolean;
}

interface ServiceCodexEnvironmentSnapshot {
  version: 1;
  allowlist: string[];
  env: Record<string, string>;
}

export interface CaptureServiceCodexEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
  /** Base Portable data dir. The snapshot store lives in a dedicated child dir. */
  dataDir?: string;
}

export interface RestoreServiceCodexEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
  /** Base Portable data dir. The snapshot store lives in a dedicated child dir. */
  dataDir?: string;
  log?: (line: string) => void;
}

export interface DeleteServiceCodexEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
  /** Base Portable data dir. The snapshot store lives in a dedicated child dir. */
  dataDir?: string;
}

/** Separate storage prevents snapshot writes racing the main credential store. */
export function resolveServiceCodexEnvironmentDataDir(
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string
): string {
  return path.join(resolveDataDir(dataDir, env), SERVICE_CODEX_ENV_STORE_DIRECTORY);
}

function resolveStore(options: {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
  dataDir?: string;
}): SecretStore {
  return (
    options.store ??
    new LocalSecretStore({
      dataDir: resolveServiceCodexEnvironmentDataDir(options.env, options.dataDir),
    })
  );
}

/** Replace the service's encrypted Codex environment snapshot from the install shell. */
export function captureServiceCodexEnvironment(
  options: CaptureServiceCodexEnvironmentOptions = {}
): void {
  const env = options.env ?? process.env;
  const store = resolveStore(options);
  const allowlist = parseCodexEnvAllowlist(env.PORTABLE_CODEX_ENV_ALLOWLIST);
  const selected = selectCodexProcessEnv(env, allowlist);
  const snapshot: ServiceCodexEnvironmentSnapshot = {
    version: 1,
    allowlist,
    env: selected,
  };
  store.set(SERVICE_CODEX_ENV_SECRET_KEY, JSON.stringify(snapshot));
}

/**
 * Fill missing service-process values from the encrypted install snapshot.
 * Existing process and `.env` values always win.
 */
export function restoreServiceCodexEnvironment(
  options: RestoreServiceCodexEnvironmentOptions = {}
): 'missing' | 'restored' | 'invalid' {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  try {
    const store = resolveStore(options);
    const raw = store.get(SERVICE_CODEX_ENV_SECRET_KEY);
    if (raw === undefined) return 'missing';
    const snapshot = parseSnapshot(raw);

    const ambientAllowlist = env.PORTABLE_CODEX_ENV_ALLOWLIST;
    const effectiveAllowlist =
      ambientAllowlist === undefined
        ? snapshot.allowlist
        : parseCodexEnvAllowlist(ambientAllowlist);
    const selected = selectCodexProcessEnv(snapshot.env, effectiveAllowlist);
    for (const [key, value] of Object.entries(selected)) {
      if (env[key] === undefined) env[key] = value;
    }
    if (ambientAllowlist === undefined && snapshot.allowlist.length > 0) {
      env.PORTABLE_CODEX_ENV_ALLOWLIST = snapshot.allowlist.join(',');
    }
    return 'restored';
  } catch {
    log('[service] ignored invalid stored Codex environment snapshot.');
    return 'invalid';
  }
}

/** Remove only the service Codex snapshot; all other local secrets remain intact. */
export function deleteServiceCodexEnvironment(
  options: DeleteServiceCodexEnvironmentOptions = {}
): boolean {
  return resolveStore(options).delete(SERVICE_CODEX_ENV_SECRET_KEY);
}

function parseSnapshot(raw: string): ServiceCodexEnvironmentSnapshot {
  const value = JSON.parse(raw) as unknown;
  if (!isPlainObject(value) || value.version !== 1) throw new Error('invalid snapshot');
  if (!Array.isArray(value.allowlist) || !value.allowlist.every((key) => typeof key === 'string')) {
    throw new Error('invalid snapshot');
  }
  const allowlist = parseCodexEnvAllowlist(value.allowlist);
  if (allowlist.length !== value.allowlist.length) throw new Error('invalid snapshot');
  if (!isPlainObject(value.env)) throw new Error('invalid snapshot');
  const entries = Object.entries(value.env);
  if (
    entries.some(
      ([key, item]) =>
        typeof item !== 'string' || item.includes('\0') || !isCodexEnvAllowed(key, allowlist)
    )
  ) {
    throw new Error('invalid snapshot');
  }
  return {
    version: 1,
    allowlist,
    env: Object.fromEntries(entries) as Record<string, string>,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
