import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { Database } from 'bun:sqlite';

import { CodexProjectsChatIndex } from '../../../src/db/CodexProjects/CodexProjectsChatIndex';
import { readCodexRollout } from '../../../src/db/CodexProjects/codexPaths';
import { parseRollout, summarizeRollout } from '../../../src/db/CodexProjects/rolloutReader';

let root: string;
let codexHome: string;
let projectsRoot: string;

const line = (value: unknown) => JSON.stringify(value);

async function writeRollout(threadId: string, cwd: string, subagent = false): Promise<string> {
  await fs.mkdir(cwd, { recursive: true });
  const dir = path.join(codexHome, 'sessions', '2026', '09', '13');
  await fs.mkdir(dir, { recursive: true });
  const rolloutPath = path.join(dir, `rollout-${threadId}.jsonl`);
  await fs.writeFile(
    rolloutPath,
    [
      line({
        timestamp: '2026-09-13T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          cwd,
          source: subagent ? { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } : 'cli',
          thread_source: subagent ? 'subagent' : 'user',
        },
      }),
      line({
        timestamp: '2026-09-13T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Prompt for ${threadId}` }],
        },
      }),
    ].join('\n')
  );
  return rolloutPath;
}

function createStateDb(): Database {
  const db = new Database(path.join(codexHome, 'state_5.sqlite'), { create: true });
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL,
    title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'cli',
    thread_source TEXT, model TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, created_at_ms INTEGER, updated_at_ms INTEGER,
    recency_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0
  )`);
  return db;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-index-'));
  codexHome = path.join(root, '.codex');
  projectsRoot = path.join(root, 'projects');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('CodexProjectsChatIndex', () => {
  it('reads state_5.sqlite without writing it and scopes sessions to the projects root', async () => {
    const inCwd = path.join(projectsRoot, 'portable', 'packages', 'api');
    const outCwd = path.join(root, 'elsewhere');
    const inRollout = await writeRollout('thread-in', inCwd);
    const outRollout = await writeRollout('thread-out', outCwd);
    const childRollout = await writeRollout('thread-child', inCwd, true);
    const db = createStateDb();
    const insert = db.prepare(
      `INSERT INTO threads
       (id, rollout_path, cwd, title, first_user_message, preview, source, thread_source,
        model, created_at, updated_at, archived, is_pinned)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 'gpt-5', 1, 2, ?, ?)`
    );
    insert.run('thread-in', inRollout, inCwd, 'State title', 'First prompt', 'cli', 'user', 0, 1);
    insert.run('thread-out', outRollout, outCwd, 'Outside', 'No', 'cli', 'user', 0, 0);
    insert.run(
      'thread-child',
      childRollout,
      inCwd,
      'Child',
      'No',
      JSON.stringify({ subagent: {} }),
      'subagent',
      0,
      0
    );
    db.close();

    const stateBefore = await fs.stat(path.join(codexHome, 'state_5.sqlite'));
    const chats = await new CodexProjectsChatIndex(codexHome, projectsRoot).discoverChats([]);
    const stateAfter = await fs.stat(path.join(codexHome, 'state_5.sqlite'));

    expect(chats.map((chat) => chat.id)).toEqual(['codex:thread-in']);
    expect(chats[0].threadId).toBe('thread-in');
    expect(chats[0].repoPath).toBe(await fs.realpath(path.join(projectsRoot, 'portable')));
    expect(chats[0].repoFullName).toBe('portable');
    expect(chats[0].title).toBe('State title');
    expect(chats[0].pinned).toBe(true);
    expect(chats[0].messageCount).toBe(1);
    expect(stateAfter.mtimeMs).toBe(stateBefore.mtimeMs);
  });

  it('finds a rollout before its state row is committed', async () => {
    const cwd = path.join(projectsRoot, 'new-project');
    await writeRollout('thread-fresh', cwd);

    const chats = await new CodexProjectsChatIndex(codexHome, projectsRoot).discoverChats([]);
    expect(chats.map((chat) => chat.id)).toEqual(['codex:thread-fresh']);
    expect(chats[0].title).toBe('Prompt for thread-fresh');
  });

  it('marks a thread running when its writer lock has an owning process', async () => {
    const cwd = path.join(projectsRoot, 'live-project');
    await writeRollout('thread-live', cwd);
    const probed: string[][] = [];
    const index = new CodexProjectsChatIndex(codexHome, projectsRoot, {
      activeThreadProbe: async (threadIds) => {
        probed.push([...threadIds]);
        return new Set(['thread-live']);
      },
    });

    const chats = await index.discoverChats([]);
    expect(probed).toEqual([['thread-live']]);
    expect(chats[0].status).toBe('running');
  });

  it('rejects cwd paths that escape the projects root through a symlink', async () => {
    const outside = path.join(root, 'outside-project');
    const linked = path.join(projectsRoot, 'linked-outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, linked);
    await writeRollout('thread-escaped-cwd', linked);

    const chats = await new CodexProjectsChatIndex(codexHome, projectsRoot).discoverChats([]);
    expect(chats).toEqual([]);
  });

  it('rejects state rows whose rollout escapes the Codex session roots', async () => {
    const cwd = path.join(projectsRoot, 'safe-project');
    await fs.mkdir(cwd, { recursive: true });
    const outsideRollout = path.join(root, 'outside.jsonl');
    await fs.writeFile(outsideRollout, 'private external data');
    const db = createStateDb();
    db.prepare(
      `INSERT INTO threads
       (id, rollout_path, cwd, title, first_user_message, source, thread_source, model,
        created_at, updated_at, archived, is_pinned)
       VALUES ('escaped', ?, ?, 'Unsafe', 'Prompt', 'cli', 'user', 'gpt-5', 1, 2, 0, 0)`
    ).run(outsideRollout, cwd);
    db.close();

    expect(await new CodexProjectsChatIndex(codexHome, projectsRoot).discoverChats([])).toEqual([]);
  });

  it('rejects a symlinked rollout even when the link lives under sessions', async () => {
    const cwd = path.join(projectsRoot, 'safe-project');
    await fs.mkdir(cwd, { recursive: true });
    const external = path.join(root, 'external.jsonl');
    await fs.writeFile(
      external,
      [
        line({ type: 'session_meta', payload: { id: 'linked', cwd, source: 'cli' } }),
        line({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'secret' }],
          },
        }),
      ].join('\n')
    );
    const dir = path.join(codexHome, 'sessions', '2026', '09', '13');
    await fs.mkdir(dir, { recursive: true });
    const linkedRollout = path.join(dir, 'rollout-linked.jsonl');
    await fs.symlink(external, linkedRollout);
    const db = createStateDb();
    db.prepare(
      `INSERT INTO threads
       (id, rollout_path, cwd, title, first_user_message, source, thread_source, model,
        created_at, updated_at, archived, is_pinned)
       VALUES ('linked', ?, ?, 'Unsafe', 'Prompt', 'cli', 'user', 'gpt-5', 1, 2, 0, 0)`
    ).run(linkedRollout, cwd);
    db.close();

    expect(await new CodexProjectsChatIndex(codexHome, projectsRoot).discoverChats([])).toEqual([]);
  });

  it('bounds rollout bytes while preserving session metadata and newest history', async () => {
    const cwd = path.join(projectsRoot, 'large-project');
    const rolloutPath = await writeRollout('large', cwd);
    await fs.appendFile(
      rolloutPath,
      `\n${Array.from({ length: 80 }, (_, index) =>
        line({
          type: 'response_item',
          timestamp: new Date(1_700_000_000_000 + index).toISOString(),
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `response-${index}` }],
          },
        })
      ).join('\n')}`
    );

    const read = await readCodexRollout(codexHome, rolloutPath, {
      maxBytes: 1_024,
      headBytes: 256,
    });
    expect(read).not.toBeNull();
    expect(read!.truncated).toBe(true);
    expect(Buffer.byteLength(read!.contents)).toBeLessThanOrEqual(1_025);
    const summary = summarizeRollout(parseRollout(read!.contents));
    expect(summary.threadId).toBe('large');
    expect(summary.cwd).toBe(cwd);
    expect((summary.lastMessageData as any).content).toBe('response-79');
  });
});
