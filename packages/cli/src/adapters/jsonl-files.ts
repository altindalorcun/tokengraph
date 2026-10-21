import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Every `*.jsonl` file under a directory, recursively; a missing directory yields nothing. */
export async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* jsonlFiles(path);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield path;
    }
  }
}

/** Streams a file line by line, so large transcripts are never loaded whole. */
export async function readLines(path: string, onLine: (line: string) => void): Promise<void> {
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of reader) onLine(line);
  } finally {
    reader.close();
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Full paths of the directories directly under a directory; a missing directory yields none. */
export async function childDirectories(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
}

/** `*.jsonl` files directly in a directory, not below it and never through a symlink; a missing directory yields nothing. */
export async function* flatJsonlFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) yield join(dir, entry.name);
  }
}
