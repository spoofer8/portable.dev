import { describe, expect, it } from 'bun:test';
import path from 'path';

import {
  createCodexThreadWriterOwnerProbe,
  createCodexThreadWriterProbe,
} from '../../../src/db/CodexProjects/threadWriterProbe';

describe('Codex thread writer probe', () => {
  it('uses argv-safe lsof paths and reports only owned thread locks on macOS', async () => {
    const codexHome = '/Users/test/.codex';
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const active = await createCodexThreadWriterProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock'],
      execFileImpl: async (command, args) => {
        calls.push({ command, args });
        return {
          exitCode: 0,
          stdout: `p123\nf7\nn${path.join(codexHome, 'thread-writer-locks', 'thread-live.lock')}\n`,
        };
      },
    })(['thread-live', '../../unsafe']);

    expect(active).toEqual(new Set(['thread-live']));
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('lsof');
    expect(calls[0].args).toEqual([
      '-Fn',
      '--',
      path.join(codexHome, 'thread-writer-locks', 'thread-live.lock'),
    ]);
  });

  it('ignores missing historical lock paths without hiding an extant active writer', async () => {
    const codexHome = '/Users/test/.codex';
    const liveLock = path.join(codexHome, 'thread-writer-locks', 'thread-live.lock');
    const calls: readonly string[][] = [];
    const active = await createCodexThreadWriterProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock'],
      execFileImpl: async (_command, args) => {
        (calls as string[][]).push([...args]);
        if (args.some((arg) => arg.endsWith('thread-historical.lock'))) {
          return {
            exitCode: 1,
            stderr: 'lsof: status error on thread-historical.lock: No such file or directory',
            stdout: `p4321\nf12\nn${liveLock}\n`,
          };
        }
        return { exitCode: 0, stdout: `p4321\nf12\nn${liveLock}\n` };
      },
    })(['thread-live', 'thread-historical']);

    expect(active).toEqual(new Set(['thread-live']));
    expect(calls).toEqual([['-Fn', '--', liveLock]]);
  });

  it('retains valid presence output when another lock disappears during lsof', async () => {
    const codexHome = '/Users/test/.codex';
    const liveLock = path.join(codexHome, 'thread-writer-locks', 'thread-live.lock');
    const active = await createCodexThreadWriterProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock', 'thread-raced.lock'],
      execFileImpl: async () => ({
        exitCode: 1,
        stderr: 'lsof: status error on thread-raced.lock: No such file or directory',
        stdout: `p4321\nf12\nn${liveLock}\n`,
      }),
    })(['thread-live', 'thread-raced']);

    expect(active).toEqual(new Set(['thread-live']));
  });

  it('does not invoke lsof outside macOS', async () => {
    let called = false;
    const active = await createCodexThreadWriterProbe('/tmp/codex', {
      platform: 'linux',
      execFileImpl: async () => {
        called = true;
        return { stdout: '', exitCode: 0 };
      },
    })(['thread-live']);

    expect(active.size).toBe(0);
    expect(called).toBe(false);
  });

  it('retains the unambiguous writer pid for a requested thread', async () => {
    const codexHome = '/Users/test/.codex';
    const snapshot = await createCodexThreadWriterOwnerProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock'],
      execFileImpl: async () => ({
        exitCode: 0,
        stdout: `p4321\nf12\nn${path.join(codexHome, 'thread-writer-locks', 'thread-live.lock')}\n`,
      }),
    })(['thread-live']);

    expect(snapshot.ok).toBe(true);
    expect(snapshot.activeThreadIds).toEqual(new Set(['thread-live']));
    expect(snapshot.owners).toEqual(new Map([['thread-live', 4321]]));
    expect(snapshot.ambiguousThreadIds.size).toBe(0);
  });

  it('refuses an ambiguous lock held by multiple pids', async () => {
    const codexHome = '/Users/test/.codex';
    const lock = path.join(codexHome, 'thread-writer-locks', 'thread-live.lock');
    const snapshot = await createCodexThreadWriterOwnerProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock'],
      execFileImpl: async () => ({
        exitCode: 0,
        stdout: `p4321\nf12\nn${lock}\np8765\nf14\nn${lock}\n`,
      }),
    })(['thread-live']);

    expect(snapshot.activeThreadIds).toEqual(new Set(['thread-live']));
    expect(snapshot.owners.size).toBe(0);
    expect(snapshot.ambiguousThreadIds).toEqual(new Set(['thread-live']));
  });

  it('allows one writer pid to own a requested parent and its nested subagent locks', async () => {
    const codexHome = '/Users/test/.codex';
    const snapshot = await createCodexThreadWriterOwnerProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock', 'thread-child.lock', 'thread-grandchild.lock'],
      readThreadParentsImpl: async () =>
        new Map([
          ['thread-child', 'thread-live'],
          ['thread-grandchild', 'thread-child'],
        ]),
      execFileImpl: async () => ({
        exitCode: 0,
        stdout: [
          'p4321',
          'f12',
          `n${path.join(codexHome, 'thread-writer-locks', 'thread-live.lock')}`,
          'f13',
          `n${path.join(codexHome, 'thread-writer-locks', 'thread-child.lock')}`,
          'f14',
          `n${path.join(codexHome, 'thread-writer-locks', 'thread-grandchild.lock')}`,
          '',
        ].join('\n'),
      }),
    })(['thread-live']);

    expect(snapshot.activeThreadIds).toEqual(new Set(['thread-live']));
    expect(snapshot.owners).toEqual(new Map([['thread-live', 4321]]));
    expect(snapshot.ambiguousThreadIds.size).toBe(0);
  });

  it('refuses one writer pid that also owns an unrelated top-level thread lock', async () => {
    const codexHome = '/Users/test/.codex';
    const snapshot = await createCodexThreadWriterOwnerProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock', 'thread-other.lock'],
      readThreadParentsImpl: async () => new Map(),
      execFileImpl: async () => ({
        exitCode: 0,
        stdout: [
          'p4321',
          'f12',
          `n${path.join(codexHome, 'thread-writer-locks', 'thread-live.lock')}`,
          'f13',
          `n${path.join(codexHome, 'thread-writer-locks', 'thread-other.lock')}`,
          '',
        ].join('\n'),
      }),
    })(['thread-live']);

    expect(snapshot.activeThreadIds).toEqual(new Set(['thread-live']));
    expect(snapshot.owners.size).toBe(0);
    expect(snapshot.ambiguousThreadIds).toEqual(new Set(['thread-live']));
  });

  it('fails closed when the writer probe cannot inspect the lock directory', async () => {
    const snapshot = await createCodexThreadWriterOwnerProbe('/Users/test/.codex', {
      platform: 'darwin',
      readDirImpl: async () => {
        throw new Error('permission denied');
      },
      execFileImpl: async () => ({ stdout: '', exitCode: 0 }),
    })(['thread-live']);

    expect(snapshot.ok).toBe(false);
    expect(snapshot.activeThreadIds.size).toBe(0);
    expect(snapshot.owners.size).toBe(0);
  });

  it('fails closed for an unsafe requested thread id', async () => {
    const snapshot = await createCodexThreadWriterOwnerProbe('/Users/test/.codex', {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock'],
      execFileImpl: async () => ({ stdout: '', exitCode: 0 }),
    })(['../../unsafe']);

    expect(snapshot.ok).toBe(false);
  });

  it('fails closed when lsof reports an inspection error', async () => {
    const snapshot = await createCodexThreadWriterOwnerProbe('/Users/test/.codex', {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock'],
      execFileImpl: async () => ({
        stdout: '',
        stderr: 'lsof: permission denied',
        exitCode: 1,
      }),
    })(['thread-live']);

    expect(snapshot.ok).toBe(false);
  });

  it('keeps owner resolution fail-closed when lsof returns partial output', async () => {
    const codexHome = '/Users/test/.codex';
    const lock = path.join(codexHome, 'thread-writer-locks', 'thread-live.lock');
    const snapshot = await createCodexThreadWriterOwnerProbe(codexHome, {
      platform: 'darwin',
      readDirImpl: async () => ['thread-live.lock', 'thread-raced.lock'],
      execFileImpl: async () => ({
        exitCode: 1,
        stderr: 'lsof: status error on thread-raced.lock: No such file or directory',
        stdout: `p4321\nf12\nn${lock}\n`,
      }),
    })(['thread-live']);

    expect(snapshot.ok).toBe(false);
    expect(snapshot.activeThreadIds.size).toBe(0);
    expect(snapshot.owners.size).toBe(0);
  });
});
