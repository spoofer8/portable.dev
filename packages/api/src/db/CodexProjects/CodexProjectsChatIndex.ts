import { promises as fs } from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import type { WorkspaceRepo } from '../ClaudeProjects/ClaudeProjectsChatIndex.js';
import {
  codexStateDbPath,
  inspectCodexRollout,
  listCodexRollouts,
  readCodexRollout,
  type CodexRolloutFile,
} from './codexPaths.js';
import { parseRollout, summarizeRollout, type RolloutSummary } from './rolloutReader.js';
import { createCodexThreadWriterProbe, type CodexThreadWriterProbe } from './threadWriterProbe.js';

interface StateThreadRow {
  id: string;
  rollout_path: string;
  cwd: string;
  title: string;
  first_user_message: string;
  preview: string;
  source: string;
  thread_source: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  recency_at_ms: number | null;
  archived: number;
  is_pinned: number;
}

interface RolloutCacheEntry extends RolloutSummary {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

export interface DiscoveredCodexChat {
  id: string;
  threadId: string;
  repoPath: string;
  cwd: string;
  repoFullName: string;
  rolloutPath: string;
  title: string;
  lastUpdated: number;
  createdAt: number;
  messageCount: number;
  firstMessageData: unknown;
  lastMessageData: unknown;
  archived: boolean;
  pinned: boolean;
  model: string | null;
  source: string;
  status: 'running' | 'completed';
}

export interface CodexProjectsChatIndexOptions {
  activeThreadProbe?: CodexThreadWriterProbe;
}

function milliseconds(ms: number | null, seconds: number): number {
  return ms && ms > 0 ? ms : seconds > 0 ? seconds * 1000 : 0;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function scopedProject(
  cwd: string,
  projectsRoot: string,
  repos: WorkspaceRepo[]
): Promise<{ repo: WorkspaceRepo; cwd: string } | null> {
  let realRoot: string;
  let realCwd: string;
  try {
    [realRoot, realCwd] = await Promise.all([fs.realpath(projectsRoot), fs.realpath(cwd)]);
  } catch {
    return null;
  }
  if (!isInside(realRoot, realCwd)) return null;

  let best: WorkspaceRepo | null = null;
  let bestLength = -1;
  for (const repo of repos) {
    try {
      const realRepo = await fs.realpath(repo.localPath);
      if (isInside(realRepo, realCwd) && realRepo.length > bestLength) {
        best = repo;
        bestLength = realRepo.length;
      }
    } catch {
      // A stale linked repository is not a valid match.
    }
  }
  if (best) return { repo: best, cwd: realCwd };

  const relative = path.relative(realRoot, realCwd);
  const projectName = relative.split(path.sep).filter(Boolean)[0];
  if (!projectName) return null;
  return {
    repo: { full_name: projectName, localPath: path.join(realRoot, projectName) },
    cwd: realCwd,
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function stateThreadIsSubagent(row: StateThreadRow): boolean {
  if (row.thread_source === 'subagent') return true;
  if (!row.source?.startsWith('{')) return false;
  try {
    const source = JSON.parse(row.source);
    return !!source && typeof source === 'object' && 'subagent' in source;
  } catch {
    return false;
  }
}

export class CodexProjectsChatIndex {
  private readonly cache = new Map<string, RolloutCacheEntry>();
  private readonly activeThreadProbe: CodexThreadWriterProbe;

  constructor(
    private readonly codexHome: string,
    private readonly projectsRoot: string,
    options: CodexProjectsChatIndexOptions = {}
  ) {
    this.activeThreadProbe = options.activeThreadProbe ?? createCodexThreadWriterProbe(codexHome);
  }

  async discoverChats(repos: WorkspaceRepo[] = []): Promise<DiscoveredCodexChat[]> {
    const [stateRows, rolloutFiles] = await Promise.all([
      this.readStateThreads(),
      listCodexRollouts(this.codexHome),
    ]);
    const filesByPath = new Map(rolloutFiles.map((file) => [path.resolve(file.filePath), file]));
    const discovered = new Map<string, DiscoveredCodexChat>();

    for (const row of stateRows) {
      if (!row.id || !row.cwd || stateThreadIsSubagent(row)) continue;
      const scoped = await scopedProject(row.cwd, this.projectsRoot, repos);
      if (!scoped) continue;
      const { repo: project, cwd } = scoped;
      const rolloutPath = path.resolve(
        path.isAbsolute(row.rollout_path)
          ? row.rollout_path
          : path.join(this.codexHome, row.rollout_path)
      );
      const rolloutFile =
        filesByPath.get(rolloutPath) ?? (await inspectCodexRollout(this.codexHome, rolloutPath));
      if (!rolloutFile) continue;
      const summary = await this.summarize(rolloutFile);
      const firstUser = firstNonEmpty(row.first_user_message, row.preview);
      const firstMessageData =
        summary?.firstMessageData ?? (firstUser ? { content: firstUser } : undefined);
      const lastMessageData = summary?.lastMessageData ?? firstMessageData;
      const updatedAt = Math.max(
        milliseconds(row.recency_at_ms, 0),
        milliseconds(row.updated_at_ms, row.updated_at),
        summary?.lastUpdated ?? 0,
        rolloutFile?.mtimeMs ?? 0
      );
      discovered.set(row.id, {
        id: `codex:${row.id}`,
        threadId: row.id,
        repoPath: project.localPath,
        cwd,
        repoFullName: project.full_name,
        rolloutPath: rolloutFile.filePath,
        title:
          firstNonEmpty(row.title, row.first_user_message, row.preview, summary?.title) ??
          'Untitled chat',
        lastUpdated: updatedAt,
        createdAt: milliseconds(row.created_at_ms, row.created_at) || updatedAt,
        messageCount: summary?.messages.length ?? (firstUser ? 1 : 0),
        firstMessageData,
        lastMessageData,
        archived: row.archived === 1,
        pinned: row.is_pinned === 1,
        model: row.model,
        source: row.source,
        status: 'completed',
      });
    }

    // The state DB is authoritative metadata, but its write can lag a freshly-created
    // rollout. Union top-level rollouts so a filesystem event can surface the session
    // immediately instead of waiting for the next Codex DB checkpoint.
    for (const file of rolloutFiles) {
      const summary = await this.summarize(file);
      if (!summary?.threadId || !summary.cwd || summary.isSubagent) continue;
      if (discovered.has(summary.threadId)) continue;
      const scoped = await scopedProject(summary.cwd, this.projectsRoot, repos);
      if (!scoped || summary.messages.length === 0) continue;
      const { repo: project, cwd } = scoped;
      discovered.set(summary.threadId, {
        id: `codex:${summary.threadId}`,
        threadId: summary.threadId,
        repoPath: project.localPath,
        cwd,
        repoFullName: project.full_name,
        rolloutPath: file.filePath,
        title: summary.title ?? 'Untitled chat',
        lastUpdated: Math.max(summary.lastUpdated, file.mtimeMs),
        createdAt: summary.messages[0]?.timestamp ?? file.mtimeMs,
        messageCount: summary.messages.length,
        firstMessageData: summary.firstMessageData,
        lastMessageData: summary.lastMessageData,
        archived: file.archived,
        pinned: false,
        model: null,
        source: 'rollout',
        status: 'completed',
      });
    }

    const activeThreadIds = await this.activeThreadProbe([...discovered.keys()]).catch(
      () => new Set<string>()
    );
    for (const threadId of activeThreadIds) {
      const chat = discovered.get(threadId);
      if (chat) chat.status = 'running';
    }

    return [...discovered.values()].sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  async findChat(
    id: string,
    repos: WorkspaceRepo[] = []
  ): Promise<DiscoveredCodexChat | undefined> {
    const threadId = id.startsWith('codex:') ? id.slice('codex:'.length) : id;
    return (await this.discoverChats(repos)).find((chat) => chat.threadId === threadId);
  }

  private async readStateThreads(): Promise<StateThreadRow[]> {
    let db: Database | undefined;
    try {
      db = new Database(codexStateDbPath(this.codexHome), { readonly: true, create: false });
      const columns = new Set(
        db
          .prepare<{ name: string }>("SELECT name FROM pragma_table_info('threads')")
          .all()
          .map((row) => row.name)
      );
      if (!columns.has('id') || !columns.has('rollout_path') || !columns.has('cwd')) return [];
      const column = (name: string, fallback: string) =>
        columns.has(name) ? name : `${fallback} AS ${name}`;
      return db
        .prepare<StateThreadRow>(
          `SELECT id, rollout_path, cwd, ${column('title', "''")}, ` +
            `${column('first_user_message', "''")}, ${column('preview', "''")}, ` +
            `${column('source', "''")}, ${column('thread_source', 'NULL')}, ` +
            `${column('model', 'NULL')}, ${column('created_at', '0')}, ` +
            `${column('updated_at', '0')}, ${column('created_at_ms', 'NULL')}, ` +
            `${column('updated_at_ms', 'NULL')}, ${column('recency_at_ms', 'NULL')}, ` +
            `${column('archived', '0')}, ${column('is_pinned', '0')} FROM threads`
        )
        .all();
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  private async summarize(file: CodexRolloutFile): Promise<RolloutCacheEntry | null> {
    const identity = await inspectCodexRollout(this.codexHome, file.filePath);
    if (!identity) return null;
    const cached = this.cache.get(identity.filePath);
    if (
      cached &&
      cached.mtimeMs === identity.mtimeMs &&
      cached.ctimeMs === identity.ctimeMs &&
      cached.size === identity.size &&
      cached.ino === identity.ino
    ) {
      return cached;
    }
    const safeRead = await readCodexRollout(this.codexHome, identity.filePath);
    if (!safeRead) return null;
    const stableIdentity = safeRead.file;
    try {
      const summary = summarizeRollout(parseRollout(safeRead.contents), stableIdentity.mtimeMs);
      const entry = {
        ...summary,
        mtimeMs: stableIdentity.mtimeMs,
        ctimeMs: stableIdentity.ctimeMs,
        size: stableIdentity.size,
        ino: stableIdentity.ino,
      };
      this.cache.set(stableIdentity.filePath, entry);
      return entry;
    } catch {
      return null;
    }
  }
}
