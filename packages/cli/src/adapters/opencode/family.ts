import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, CollectResult } from '@tokengraph/core';
import { OpenCodeAggregator, type OpenCodeDiagnostics } from './aggregator.js';
import type { OpenCodeFlavour } from './flavour.js';
import { loadSqlite as defaultLoadSqlite, readOpenCodeDatabase } from './sqlite.js';
import { readOpenCodeStorage } from './storage.js';

/**
 * `${XDG_DATA_HOME || ~/.local/share}/<dataDirName>` — the same rule OpenCode and Kilo use (never `~/Library/...`
 * on macOS). An empty XDG_DATA_HOME counts as unset, as in the XDG spec and the xdg-basedir package both use.
 */
export function familyDataDir(flavour: OpenCodeFlavour): string {
  return join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), flavour.dataDirName);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every database file to read: just the product's `…_DB` variable when it's set to something other
 * than `:memory:` (relative paths resolve against the data dir), else every file in the data dir
 * matching the flavour's pattern.
 */
async function databasePaths(flavour: OpenCodeFlavour, dataDir: string): Promise<string[]> {
  const override = process.env[flavour.dbEnvVar];
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
    .filter((entry) => entry.isFile() && flavour.dbPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(dataDir, name));
}

function describeDiagnostics(flavour: OpenCodeFlavour, d: OpenCodeDiagnostics): string[] {
  const name = flavour.displayName;
  const notes: string[] = [];
  if (d.skippedOld > 0) {
    notes.push(`skipped ${d.skippedOld} ${name} request(s) from before v${flavour.rules.periodDFloor} whose token fields cannot be interpreted with certainty`);
  }
  if (d.invalidRecords > 0) notes.push(`skipped ${d.invalidRecords} ${name} record(s) with missing or invalid token counts`);
  if (d.skippedClaudeCode > 0) {
    notes.push(`skipped ${d.skippedClaudeCode} request(s) made through the claude-code provider (already counted from Claude Code)`);
  }
  if (d.unreadableSources > 0) notes.push(`${d.unreadableSources} ${name} database(s) or file(s) could not be read`);
  return notes;
}

export interface OpenCodeFamilyOptions {
  timeZone?: string;
  /** Overrides `loadSqlite`, so tests can simulate a Node build without `node:sqlite`. */
  loadSqlite?: () => Promise<typeof DatabaseSync | null>;
}

/**
 * The adapter for a product that writes OpenCode's database: the flavour says where it lives and
 * which release numbers its token semantics are keyed to (see `OpenCodeFlavour`). Every database in
 * the data dir (v1 `message`/`part` and v2 `session_message`), plus the pre-1.2 JSON store when the
 * flavour has one, goes into one aggregator so a message migrated or duplicated across sources is
 * counted once. Only counters, ids, model/provider ids and timestamps are ever read — never
 * prompt/response text, tool output or file paths — and credential files and logs are never opened.
 */
export function createOpenCodeFamilyAdapter(flavour: OpenCodeFlavour, options: OpenCodeFamilyOptions = {}): Adapter {
  const loadSqlite = options.loadSqlite ?? defaultLoadSqlite;

  return {
    name: flavour.source,

    async detect(): Promise<boolean> {
      const dataDir = familyDataDir(flavour);
      if (!(await isDirectory(dataDir))) return false;
      if ((await databasePaths(flavour, dataDir)).length > 0) return true;
      return flavour.readsJsonStorage && isDirectory(join(dataDir, 'storage'));
    },

    async collect(since: Date): Promise<CollectResult> {
      const dataDir = familyDataDir(flavour);
      const aggregator = new OpenCodeAggregator({ since, timeZone: options.timeZone, flavour });
      const notes: string[] = [];

      const storageDir = join(dataDir, 'storage');
      if (flavour.readsJsonStorage && (await isDirectory(storageDir))) {
        await readOpenCodeStorage(storageDir, aggregator, since.getTime());
      }

      const dbPaths = await databasePaths(flavour, dataDir);
      if (dbPaths.length > 0) {
        const DatabaseSync = await loadSqlite();
        if (!DatabaseSync) {
          notes.push(
            `${flavour.displayName} needs Node 22.13+ to read ${flavour.dbFileName} (this is Node ${process.versions.node}); ${flavour.displayName} usage was skipped`,
          );
        } else {
          for (const path of dbPaths) {
            try {
              readOpenCodeDatabase(DatabaseSync, path, aggregator, since.getTime(), { readStepModels: flavour.readsStepModels });
            } catch {
              aggregator.noteUnreadableSource();
            }
          }
        }
      }

      const result = aggregator.result();
      notes.push(...describeDiagnostics(flavour, aggregator.diagnostics()));

      return { ...result, ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
