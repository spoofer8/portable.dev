import { selectCodexProcessEnv } from '@vgit2/shared/codexEnv';

/** Builds the minimal environment inherited by a Codex app-server child. */
export const buildCodexProcessEnv = (
  source: NodeJS.ProcessEnv = process.env,
  extraAllowedKeys?: readonly string[]
): NodeJS.ProcessEnv => selectCodexProcessEnv(source, extraAllowedKeys);
