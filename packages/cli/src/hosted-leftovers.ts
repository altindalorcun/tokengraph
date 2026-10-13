import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome } from './paths.js';

/** Files only the hosted version wrote. Removing them is tidy-up, so it never fails a command. */
const HOSTED_FILES = ['uploaded.json'] as const;

export async function removeHostedLeftovers(home: string = configHome()): Promise<void> {
  await Promise.all(HOSTED_FILES.map((file) => rm(join(home, file), { force: true }).catch(() => undefined)));
}
