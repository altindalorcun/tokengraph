import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Deep enough for `<account>/<org>/<session>/.claude` with room to spare, shallow enough to stay out of a mounted workspace. */
const MAX_DEPTH = 8;
/** A safety net, not a limit anyone should reach: Cowork sessions may mount user folders. */
const MAX_DIRECTORIES = 20_000;

/**
 * The `.claude` folders under one of Claude Desktop's session folders (`local-agent-mode-sessions`,
 * `claude-code-sessions`). Never follows a symlink (a `Dirent` for a link is neither a directory nor
 * a file), does not descend into a `.claude` it found, and is bounded in depth and in the number of
 * folders it lists. A missing folder yields nothing.
 */
export async function* desktopClaudeDirs(base: string): AsyncGenerator<string> {
  let visited = 0;
  async function* walk(dir: string, depth: number): AsyncGenerator<string> {
    if (visited >= MAX_DIRECTORIES) return;
    visited += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === '.claude') yield path;
      else if (depth < MAX_DEPTH) yield* walk(path, depth + 1);
    }
  }
  yield* walk(base, 0);
}
