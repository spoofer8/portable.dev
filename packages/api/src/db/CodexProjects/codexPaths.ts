import { constants, promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.codex');
}

export function resolveProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PORTABLE_PROJECTS_ROOT?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), 'projects');
}

export function codexStateDbPath(codexHome: string): string {
  return path.join(codexHome, 'state_5.sqlite');
}

export interface CodexRolloutFile {
  filePath: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  archived: boolean;
}

export interface CodexRolloutRead {
  contents: string;
  file: CodexRolloutFile;
  /** True when the bounded reader preserved the header and tail but omitted the middle. */
  truncated: boolean;
}

export interface CodexRolloutReadOptions {
  maxBytes?: number;
  headBytes?: number;
}

export const MAX_CODEX_ROLLOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEAD_BYTES = 256 * 1024;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function sameIdentity(a: CodexRolloutFile, b: CodexRolloutFile): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Resolve and validate a regular rollout without following a final-component symlink. */
export async function inspectCodexRollout(
  codexHome: string,
  filePath: string
): Promise<CodexRolloutFile | null> {
  try {
    const [realHome, linkStat, realFile] = await Promise.all([
      fs.realpath(codexHome),
      fs.lstat(filePath),
      fs.realpath(filePath),
    ]);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
    const sessionsRoot = path.join(realHome, 'sessions');
    const archivedRoot = path.join(realHome, 'archived_sessions');
    const archived = isInside(archivedRoot, realFile);
    if (!archived && !isInside(sessionsRoot, realFile)) return null;
    return {
      filePath: realFile,
      mtimeMs: linkStat.mtimeMs,
      ctimeMs: linkStat.ctimeMs,
      size: linkStat.size,
      ino: linkStat.ino,
      archived,
    };
  } catch {
    return null;
  }
}

/**
 * Read through an O_NOFOLLOW descriptor and verify the file identity before and
 * after the read. A replaced/truncated rollout is retried once on the next scan.
 */
export async function readCodexRollout(
  codexHome: string,
  filePath: string,
  options: CodexRolloutReadOptions = {}
): Promise<CodexRolloutRead | null> {
  const inspected = await inspectCodexRollout(codexHome, filePath);
  if (!inspected) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(inspected.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const beforeStat = await handle.stat();
    const before: CodexRolloutFile = {
      ...inspected,
      mtimeMs: beforeStat.mtimeMs,
      ctimeMs: beforeStat.ctimeMs,
      size: beforeStat.size,
      ino: beforeStat.ino,
    };
    if (!beforeStat.isFile() || !sameIdentity(inspected, before)) return null;
    const maxBytes = Math.max(2, options.maxBytes ?? MAX_CODEX_ROLLOUT_BYTES);
    let contents: string;
    const truncated = beforeStat.size > maxBytes;
    if (!truncated) {
      contents = await handle.readFile({ encoding: 'utf8' });
    } else {
      const headBytes = Math.min(
        Math.max(1, options.headBytes ?? DEFAULT_HEAD_BYTES),
        maxBytes - 1
      );
      const tailBytes = maxBytes - headBytes - 1;
      const head = Buffer.allocUnsafe(headBytes);
      const tail = Buffer.allocUnsafe(tailBytes);
      const headRead = await handle.read(head, 0, headBytes, 0);
      const tailRead = await handle.read(tail, 0, tailBytes, beforeStat.size - tailBytes);
      const headText = head.subarray(0, headRead.bytesRead).toString('utf8');
      const tailText = tail.subarray(0, tailRead.bytesRead).toString('utf8');
      const firstNewline = tailText.indexOf('\n');
      contents = `${headText}\n${firstNewline >= 0 ? tailText.slice(firstNewline + 1) : ''}`;
    }
    const afterStat = await handle.stat();
    const afterPath = await inspectCodexRollout(codexHome, inspected.filePath);
    const after: CodexRolloutFile = {
      ...inspected,
      mtimeMs: afterStat.mtimeMs,
      ctimeMs: afterStat.ctimeMs,
      size: afterStat.size,
      ino: afterStat.ino,
    };
    if (!afterPath || !sameIdentity(before, after) || !sameIdentity(before, afterPath)) return null;
    return { contents, file: afterPath, truncated };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function walkJsonl(
  codexHome: string,
  root: string,
  archived: boolean,
  out: CodexRolloutFile[]
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(codexHome, entryPath, archived, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const rollout = await inspectCodexRollout(codexHome, entryPath);
    if (rollout) out.push({ ...rollout, archived });
  }
}

export async function listCodexRollouts(codexHome: string): Promise<CodexRolloutFile[]> {
  const out: CodexRolloutFile[] = [];
  await walkJsonl(codexHome, path.join(codexHome, 'sessions'), false, out);
  await walkJsonl(codexHome, path.join(codexHome, 'archived_sessions'), true, out);
  return out;
}
