import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type CodexPresetId = 'supersol' | 'superastra';

export interface CodexPresetConfig {
  model: string;
  modelProvider: string;
  sandbox: 'workspace-write';
  effort: 'ultra';
  config: Record<string, string | number | boolean>;
}

/**
 * Native app-server equivalents of the operator's interactive shell aliases.
 * Portable always spawns the real `codex` executable; aliases only select these
 * settings and therefore do not depend on an interactive zsh process.
 */
export const DEFAULT_CODEX_PRESETS: Readonly<Record<CodexPresetId, CodexPresetConfig>> = {
  supersol: {
    model: 'gpt-5.6-sol',
    modelProvider: 'cliproxy',
    sandbox: 'workspace-write',
    effort: 'ultra',
    config: {
      model_context_window: 1_050_000,
      model_auto_compact_token_limit: 900_000,
    },
  },
  superastra: {
    model: 'gpt-6-astra',
    modelProvider: 'cliproxy',
    sandbox: 'workspace-write',
    effort: 'ultra',
    config: {
      model_context_window: 1_050_000,
      model_auto_compact_token_limit: 900_000,
    },
  },
};

export type CodexCapability =
  { available: true; command: string; version: string } | { available: false };

type AccessImpl = (candidate: string) => boolean;
type ProbeVersionImpl = (command: string) => Promise<string | null>;

export interface DiscoverCodexCapabilityOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  accessImpl?: AccessImpl;
  probeVersion?: ProbeVersionImpl;
}

const realAccess: AccessImpl = (candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const realProbeVersion: ProbeVersionImpl = (command) =>
  new Promise((resolve) => {
    execFile(
      command,
      ['--version'],
      { encoding: 'utf8', timeout: 1_500, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
        resolve(firstLine.slice(0, 160) || null);
      }
    );
  });

function isPath(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/**
 * Locate executable Codex candidates without evaluating a shell. In particular,
 * this never resolves or executes the `supersol` and `superastra` zsh aliases.
 */
export function resolveCodexCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
  accessImpl: AccessImpl = realAccess
): string[] {
  const explicit = env.CODEX_BIN?.trim();
  if (explicit && explicit !== 'supersol' && explicit !== 'superastra') {
    return !isPath(explicit) || accessImpl(explicit) ? [explicit] : [];
  }
  if (platform !== 'darwin') return [];

  let home = '';
  try {
    home = homedir();
  } catch {
    // PATH candidates can still be checked when the home directory is unavailable.
  }

  const pathCandidates = (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'codex'));
  const commonCandidates = home
    ? [
        path.join(home, '.local', 'bin', 'codex'),
        path.join(home, '.npm-global', 'bin', 'codex'),
        path.join(home, '.bun', 'bin', 'codex'),
        path.join(home, '.volta', 'bin', 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
      ]
    : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'];

  return [...new Set([...pathCandidates, ...commonCandidates])].filter((candidate) => {
    try {
      return accessImpl(candidate);
    } catch {
      return false;
    }
  });
}

/**
 * Probe Codex asynchronously and fail open. Codex is an optional provider, so a
 * missing, broken, or slow executable must never prevent the Claude runtime from
 * booting.
 */
export async function discoverCodexCapability(
  options: DiscoverCodexCapabilityOptions = {}
): Promise<CodexCapability> {
  const candidates = resolveCodexCandidates(
    options.env,
    options.platform,
    options.homedir,
    options.accessImpl
  );
  const probeVersion = options.probeVersion ?? realProbeVersion;

  for (const command of candidates) {
    try {
      const rawVersion = await probeVersion(command);
      const version = rawVersion?.split(/\r?\n/, 1)[0]?.trim().slice(0, 160);
      if (version) return { available: true, command, version };
    } catch {
      // A broken candidate is skipped. Discovery is advisory and never fatal.
    }
  }
  return { available: false };
}

export function formatCodexCapabilityGuidance(capability: CodexCapability): string[] {
  if (capability.available) {
    return [
      `[launcher] ✓ Codex ready: ${capability.command} (${capability.version}); presets: supersol, superastra`,
    ];
  }
  return [
    '[launcher] Codex CLI not found; continuing with Claude support.',
    '[launcher]   Install Codex with `npm install -g @openai/codex`, then restart Portable.',
  ];
}

/**
 * Keep an operator-supplied mapping byte-for-byte intact. Otherwise expose the
 * safe built-in aliases. Provider credentials remain in CODEX_HOME/provider env.
 */
export function resolveCodexPresetsJson(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_PRESETS_JSON;
  return configured?.trim() ? configured : JSON.stringify(DEFAULT_CODEX_PRESETS);
}
