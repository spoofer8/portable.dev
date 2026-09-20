import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { codexStateDbPath } from './codexPaths.js';

export type CodexThreadWriterProbe = (threadIds: readonly string[]) => Promise<Set<string>>;

export interface CodexThreadWriterSnapshot {
  /** False means inspection failed and callers must not infer that a thread ended. */
  ok: boolean;
  /** Requested threads with at least one process holding their writer lock. */
  activeThreadIds: Set<string>;
  /** Requested threads whose lock has exactly one exclusive, safely-identifiable owner. */
  owners: Map<string, number>;
  /** Active threads that cannot be mapped to one safe process. */
  ambiguousThreadIds: Set<string>;
}

export type CodexThreadWriterOwnerProbe = (
  threadIds: readonly string[]
) => Promise<CodexThreadWriterSnapshot>;

type ExecFileProbe = (
  command: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr?: string; exitCode: number; failed?: boolean }>;

type ReadDirProbe = (directory: string) => Promise<readonly string[]>;
type ReadThreadParentsProbe = () => Promise<ReadonlyMap<string, string>>;

export interface CodexThreadWriterProbeOptions {
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileProbe;
  readDirImpl?: ReadDirProbe;
  readThreadParentsImpl?: ReadThreadParentsProbe;
}

const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LSOF_BATCH_SIZE = 200;

const realExecFile: ExecFileProbe = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', timeout: 1_500, maxBuffer: 512 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? -1 : 0;
        resolve({
          stdout,
          stderr,
          exitCode: code,
          // lsof exits 1 when none of the named files are open. Spawn failures,
          // timeouts, and other exit codes are inspection failures.
          failed: !!error && code !== 1,
        });
      }
    );
  });

const realReadDir: ReadDirProbe = (directory) => fs.readdir(directory);

interface ThreadLineageRow {
  id: string;
  source: string | null;
}

function parseParentThreadId(source: string | null): string | undefined {
  if (!source?.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(source) as {
      subagent?: { thread_spawn?: { parent_thread_id?: unknown } };
    };
    const parent = parsed.subagent?.thread_spawn?.parent_thread_id;
    return typeof parent === 'string' && SAFE_THREAD_ID.test(parent) ? parent : undefined;
  } catch {
    return undefined;
  }
}

function createThreadParentReader(codexHome: string): ReadThreadParentsProbe {
  return async () => {
    const parents = new Map<string, string>();
    let db: Database | undefined;
    try {
      db = new Database(codexStateDbPath(codexHome), { readonly: true, create: false });
      const rows = db.prepare<ThreadLineageRow>('SELECT id, source FROM threads').all();
      for (const row of rows) {
        if (!SAFE_THREAD_ID.test(row.id)) continue;
        const parent = parseParentThreadId(row.source);
        if (parent) parents.set(row.id, parent);
      }
    } catch {
      // Missing or unreadable lineage cannot authorize a shared-process kill.
    } finally {
      db?.close();
    }
    return parents;
  };
}

function isDescendantOf(
  threadId: string,
  rootThreadId: string,
  parents: ReadonlyMap<string, string>
): boolean {
  const visited = new Set<string>();
  let current = threadId;
  while (!visited.has(current)) {
    visited.add(current);
    const parent = parents.get(current);
    if (!parent) return false;
    if (parent === rootThreadId) return true;
    current = parent;
  }
  return false;
}

interface ParsedWriterLocks {
  threadToPids: Map<string, Set<number>>;
  pidToThreads: Map<number, Set<string>>;
}

function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key) ?? new Set<V>();
  values.add(value);
  map.set(key, values);
}

async function inspectLockPaths(
  lockToThread: Map<string, string>,
  run: ExecFileProbe
): Promise<{ ok: boolean; parsed: ParsedWriterLocks }> {
  const parsed: ParsedWriterLocks = {
    threadToPids: new Map(),
    pidToThreads: new Map(),
  };
  const lockPaths = [...lockToThread.keys()];
  for (let offset = 0; offset < lockPaths.length; offset += LSOF_BATCH_SIZE) {
    const batch = lockPaths.slice(offset, offset + LSOF_BATCH_SIZE);
    const result = await run('lsof', ['-Fn', '--', ...batch]);

    let pid: number | undefined;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith('p')) {
        const candidate = Number(line.slice(1));
        pid = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
        continue;
      }
      if (!pid || !line.startsWith('n')) continue;
      const threadId = lockToThread.get(line.slice(1));
      if (!threadId) continue;
      addToSetMap(parsed.threadToPids, threadId, pid);
      addToSetMap(parsed.pidToThreads, pid, threadId);
    }
    if (result.failed || result.stderr?.trim() || result.exitCode < 0 || result.exitCode > 1) {
      return { ok: false, parsed };
    }
  }
  return { ok: true, parsed };
}

/** Build a macOS-only, argv-safe probe for Codex's per-thread writer locks. */
export function createCodexThreadWriterProbe(
  codexHome: string,
  options: CodexThreadWriterProbeOptions = {}
): CodexThreadWriterProbe {
  const platform = options.platform ?? process.platform;
  const run = options.execFileImpl ?? realExecFile;
  const readDir = options.readDirImpl ?? realReadDir;
  return async (threadIds) => {
    if (platform !== 'darwin') return new Set();
    const lockDirectory = path.join(codexHome, 'thread-writer-locks');
    let extantLocks: Set<string>;
    try {
      extantLocks = new Set(await readDir(lockDirectory));
    } catch {
      return new Set();
    }
    const lockToThread = new Map<string, string>();
    for (const threadId of threadIds) {
      if (!SAFE_THREAD_ID.test(threadId)) continue;
      const lockName = `${threadId}.lock`;
      if (!extantLocks.has(lockName)) continue;
      lockToThread.set(path.join(lockDirectory, lockName), threadId);
    }
    if (lockToThread.size === 0) return new Set();
    const { parsed } = await inspectLockPaths(lockToThread, run);
    return new Set(parsed.threadToPids.keys());
  };
}

/**
 * Resolve an external Codex thread to the process that exclusively owns its
 * writer lock. Every lock in the directory is inspected. A process may own the
 * requested parent plus locks for its spawned subagent tree; that relationship
 * is verified against Codex's read-only state DB. Any unrelated lock makes the
 * process ambiguous and therefore unsafe to signal.
 */
export function createCodexThreadWriterOwnerProbe(
  codexHome: string,
  options: CodexThreadWriterProbeOptions = {}
): CodexThreadWriterOwnerProbe {
  const platform = options.platform ?? process.platform;
  const run = options.execFileImpl ?? realExecFile;
  const readDir = options.readDirImpl ?? realReadDir;
  const readThreadParents = options.readThreadParentsImpl ?? createThreadParentReader(codexHome);

  return async (threadIds) => {
    const empty = (): CodexThreadWriterSnapshot => ({
      ok: platform === 'darwin',
      activeThreadIds: new Set(),
      owners: new Map(),
      ambiguousThreadIds: new Set(),
    });
    if (platform !== 'darwin') return empty();

    const requested = new Set(threadIds.filter((threadId) => SAFE_THREAD_ID.test(threadId)));
    if (requested.size !== threadIds.length || requested.size === 0) {
      return { ...empty(), ok: false };
    }

    const lockDirectory = path.join(codexHome, 'thread-writer-locks');
    let entries: readonly string[];
    try {
      entries = await readDir(lockDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return empty();
      return { ...empty(), ok: false };
    }

    const lockToThread = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.endsWith('.lock')) continue;
      const threadId = entry.slice(0, -'.lock'.length);
      if (!SAFE_THREAD_ID.test(threadId)) continue;
      lockToThread.set(path.join(lockDirectory, entry), threadId);
    }
    if (lockToThread.size === 0) return empty();

    const { ok, parsed } = await inspectLockPaths(lockToThread, run);
    if (!ok) return { ...empty(), ok: false };

    const activeThreadIds = new Set<string>();
    const owners = new Map<string, number>();
    const ambiguousThreadIds = new Set<string>();
    let parents: ReadonlyMap<string, string> | undefined;
    for (const threadId of requested) {
      const pids = parsed.threadToPids.get(threadId);
      if (!pids || pids.size === 0) continue;
      activeThreadIds.add(threadId);
      if (pids.size !== 1) {
        ambiguousThreadIds.add(threadId);
        continue;
      }
      const [pid] = pids;
      const pidThreads = parsed.pidToThreads.get(pid) ?? new Set<string>();
      if (pidThreads.size > 1) {
        parents ??= await readThreadParents();
      }
      const sameThreadTree = [...pidThreads].every(
        (ownedThreadId) =>
          ownedThreadId === threadId ||
          isDescendantOf(ownedThreadId, threadId, parents ?? new Map())
      );
      if (!sameThreadTree) {
        ambiguousThreadIds.add(threadId);
        continue;
      }
      owners.set(threadId, pid);
    }

    return { ok: true, activeThreadIds, owners, ambiguousThreadIds };
  };
}
