import fs from 'fs';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import { resolveWakeCapability, WAKE_CAPABILITY_SECRET_KEY } from './config.js';

async function main(): Promise<void> {
  const wakeUrl = process.argv[2]?.trim();
  const wakeToken = fs.readFileSync(0, 'utf8').trim();
  const capability = resolveWakeCapability({
    PORTABLE_WAKE_URL: wakeUrl,
    PORTABLE_WAKE_TOKEN: wakeToken,
  });
  if (!capability) throw new Error('Wake capability is required');

  new LocalSecretStore().setJSON(WAKE_CAPABILITY_SECRET_KEY, capability);
  process.stdout.write('Portable wake capability stored securely.\n');
}

void main().catch((error) => {
  process.stderr.write(
    `Failed to store Portable wake capability: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
