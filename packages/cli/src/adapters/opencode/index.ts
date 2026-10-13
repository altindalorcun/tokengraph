import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OPENCODE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { OpenCodeAggregator, type OpenCodeDiagnostics } from './aggregator.js';
import { loadSqlite as defaultLoadSqlite, readOpenCodeDatabase } from './sqlite.js';
import { readOpenCodeStorage } from './storage.js';

/** `opencode.db`, or a channel-suffixed sibling such as `opencode-dev.db` / `opencode-beta.db`. */
const DB_NAME_PATTERN = /^opencode(-[^.]+)?\.db$/;

/** `${XDG_DATA_HOME ?? ~/.local/share}/opencode` — the same rule OpenCode itself uses (never `~/Library/...` on macOS). */
export function openCodeDataDir(): string {
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'opencode');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `opencode*.db` file to read: just `OPENCODE_DB` when it's set to something other than
 * `:memory:` (relative paths resolve against the data dir), else every file in the data dir
 * matching {@link DB_NAME_PATTERN}.
 */
async function databasePaths(dataDir: string): Promise<string[]> {
  const override = process.env['OPENCODE_DB'];
  if (override && override !== ':memory:') {
    return [isAbsolute(override) ? override : join(dataDir, override)];
  }
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && DB_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(dataDir, name));
}

function describeDiagnostics(d: OpenCodeDiagnostics): string[] {
  const notes: string[] = [];
  if (d.skippedOld > 0) {
    notes.push(`skipped ${d.skippedOld} OpenCode request(s) from before v1.3.16 whose token fields cannot be interpreted with certainty`);
  }
  if (d.invalidRecords > 0) notes.push(`skipped ${d.invalidRecords} OpenCode record(s) with missing or invalid token counts`);
  if (d.skippedClaudeCode > 0) {
    notes.push(`skipped ${d.skippedClaudeCode} request(s) made through the claude-code provider (already counted from Claude Code)`);
  }
  if (d.unreadableSources > 0) notes.push(`${d.unreadableSources} OpenCode database(s) or file(s) could not be read`);
  return notes;
}

export interface OpenCodeAdapterOptions {
  timeZone?: string;
  /** Overrides `loadSqlite`, so tests can simulate a Node build without `node:sqlite`. */
  loadSqlite?: () => Promise<typeof DatabaseSync | null>;
}

/**
 * Reads OpenCode's own local, per-request usage: the pre-1.2 JSON store and every
 * `opencode*.db` (v1 `message`/`part` and v2 `session_message`) in the data directory, merged
 * into one aggregator so a message migrated or duplicated across sources is counted once (see
 * `OpenCodeAggregator`). Only counters, ids, model/provider ids and timestamps are ever read —
 * never prompt/response text, tool output or file paths — and `auth.json`, `mcp-auth.json` and
 * `log/` are never opened.
 */
export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): Adapter {
  const loadSqlite = options.loadSqlite ?? defaultLoadSqlite;

  return {
    name: OPENCODE_SOURCE,

    async detect(): Promise<boolean> {
      const dataDir = openCodeDataDir();
      if (!(await isDirectory(dataDir))) return false;
      if ((await databasePaths(dataDir)).length > 0) return true;
      return isDirectory(join(dataDir, 'storage'));
    },

    async collect(since: Date): Promise<CollectResult> {
      const dataDir = openCodeDataDir();
      const aggregator = new OpenCodeAggregator({ since, timeZone: options.timeZone });
      const notes: string[] = [];

      const storageDir = join(dataDir, 'storage');
      if (await isDirectory(storageDir)) {
        await readOpenCodeStorage(storageDir, aggregator, since.getTime());
      }

      const dbPaths = await databasePaths(dataDir);
      if (dbPaths.length > 0) {
        const DatabaseSync = await loadSqlite();
        if (!DatabaseSync) {
          notes.push(`OpenCode needs Node 22.13+ to read opencode.db (this is Node ${process.versions.node}); OpenCode usage was skipped`);
        } else {
          for (const path of dbPaths) {
            try {
              readOpenCodeDatabase(DatabaseSync, path, aggregator, since.getTime());
            } catch {
              aggregator.noteUnreadableSource();
            }
          }
        }
      }

      const result = aggregator.result();
      notes.push(...describeDiagnostics(aggregator.diagnostics()));

      return { ...result, ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
