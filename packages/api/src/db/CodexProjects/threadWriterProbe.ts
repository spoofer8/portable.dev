import { execFile } from 'child_process';
import path from 'path';

export type CodexThreadWriterProbe = (threadIds: readonly string[]) => Promise<Set<string>>;

type ExecFileProbe = (
  command: string,
  args: readonly string[]
) => Promise<{ stdout: string; exitCode: number }>;

export interface CodexThreadWriterProbeOptions {
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileProbe;
}

const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LSOF_BATCH_SIZE = 200;

const realExecFile: ExecFileProbe = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', timeout: 1_500, maxBuffer: 512 * 1024, windowsHide: true },
      (error, stdout) => resolve({ stdout, exitCode: error ? 1 : 0 })
    );
  });

/** Build a macOS-only, argv-safe probe for Codex's per-thread writer locks. */
export function createCodexThreadWriterProbe(
  codexHome: string,
  options: CodexThreadWriterProbeOptions = {}
): CodexThreadWriterProbe {
  const platform = options.platform ?? process.platform;
  const run = options.execFileImpl ?? realExecFile;
  return async (threadIds) => {
    if (platform !== 'darwin') return new Set();
    const lockToThread = new Map<string, string>();
    for (const threadId of threadIds) {
      if (!SAFE_THREAD_ID.test(threadId)) continue;
      lockToThread.set(path.join(codexHome, 'thread-writer-locks', `${threadId}.lock`), threadId);
    }
    const lockPaths = [...lockToThread.keys()];
    const active = new Set<string>();
    for (let offset = 0; offset < lockPaths.length; offset += LSOF_BATCH_SIZE) {
      const batch = lockPaths.slice(offset, offset + LSOF_BATCH_SIZE);
      const { stdout } = await run('lsof', ['-Fn', '--', ...batch]);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith('n')) continue;
        const threadId = lockToThread.get(line.slice(1));
        if (threadId) active.add(threadId);
      }
    }
    return active;
  };
}
