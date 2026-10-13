import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { machinesCachePath } from '../paths.js';
import { parseMachineFile, serializeMachineFile, type MachineFile } from './machines.js';

/** Other machines' files from the last publish, so offline commands (story) show all-machine numbers. */
export async function readMachinesCache(path = machinesCachePath()): Promise<MachineFile[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { schema?: unknown; files?: unknown };
    if (raw.schema !== 1 || !Array.isArray(raw.files)) return [];
    return raw.files.flatMap((entry) => {
      const parsed = typeof entry === 'string' ? parseMachineFile(entry) : null;
      return parsed ? [parsed] : [];
    });
  } catch {
    return [];
  }
}

/** When the last successful publish finished (ISO), or null before the first one. */
export async function readLastPublish(path = machinesCachePath()): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { publishedAt?: unknown };
    return typeof raw.publishedAt === 'string' && !Number.isNaN(Date.parse(raw.publishedAt)) ? raw.publishedAt : null;
  } catch {
    return null;
  }
}

export async function writeMachinesCache(files: readonly MachineFile[], path = machinesCachePath(), publishedAt?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ schema: 1, ...(publishedAt ? { publishedAt } : {}), files: files.map(serializeMachineFile) }), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
