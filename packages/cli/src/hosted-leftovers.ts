import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome } from './paths.js';

/** Files an earlier pre-release build wrote that nothing reads now. Removing them is tidy-up, so it never fails a command. */
const HOSTED_FILES = ['uploaded.json'] as const;

export async function removeHostedLeftovers(home: string = configHome()): Promise<void> {
  await Promise.all(HOSTED_FILES.map((file) => rm(join(home, file), { force: true }).catch(() => undefined)));
}
