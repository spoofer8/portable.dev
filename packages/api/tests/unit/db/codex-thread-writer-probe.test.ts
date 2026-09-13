import { describe, expect, it } from 'bun:test';
import path from 'path';

import { createCodexThreadWriterProbe } from '../../../src/db/CodexProjects/threadWriterProbe';

describe('Codex thread writer probe', () => {
  it('uses argv-safe lsof paths and reports only owned thread locks on macOS', async () => {
    const codexHome = '/Users/test/.codex';
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const active = await createCodexThreadWriterProbe(codexHome, {
      platform: 'darwin',
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
});
