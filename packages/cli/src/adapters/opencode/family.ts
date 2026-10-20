import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, CollectResult } from '@tokengraph/core';
import { isDirectoryPath, pathFor, planScan, processRootContext, type RootContext, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { OpenCodeAggregator, type OpenCodeDiagnostics } from './aggregator.js';
import { familyRootSpec } from './family-roots.js';
import type { OpenCodeFlavour } from './flavour.js';
import { loadSqlite as defaultLoadSqlite, readOpenCodeDatabase } from './sqlite.js';
import { readOpenCodeStorage } from './storage.js';

/**
 * `${XDG_DATA_HOME || ~/.local/share}/<dataDirName>` for this process's environment: the same rule OpenCode
 * and Kilo use (never `~/Library/...` on macOS). An empty XDG_DATA_HOME counts as unset, as in the XDG spec and
 * the xdg-basedir package both use. The adapter also reads the default folder, a database named by the
 * product's `..._DB` variable and remembered folders.
 */
export function familyDataDir(flavour: OpenCodeFlavour, ctx: RootContext = processRootContext()): string {
  const roots = familyRootSpec(flavour).fromEnv(ctx).filter((root) => !/\.db$/i.test(root));
  return roots[0] ?? pathFor(ctx.platform).join(ctx.home, '.local', 'share', flavour.dataDirName);
}

/** Every database file in a data dir whose name matches the flavour's pattern, sorted. */
async function databasesIn(flavour: OpenCodeFlavour, dataDir: string): Promise<string[]> {
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

export interface OpenCodeFamilyOptions extends RootsOption {
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
  const spec = familyRootSpec(flavour);

  /**
   * What exists: data folders (their databases and, for OpenCode, their pre-1.2 `storage/` tree) and databases
   * named directly. A database reached twice (a folder's listing and a `..._DB` path, two spellings of one
   * folder) is listed once: message ids and fork fingerprints dedup across different databases, but one
   * file read twice would only repeat work.
   */
  const plan = async (): Promise<{ dataDirs: string[]; databases: string[] }> => {
    const { ctx, remembered } = await resolveAdapterRoots(spec, options.roots);
    const existing = (await planScan(spec, ctx, remembered)).filter((target) => target.exists);
    const dataDirs = existing.filter((target) => target.kind === 'dir').map((target) => target.path);
    const files = new Set<string>();
    for (const dir of dataDirs) for (const path of await databasesIn(flavour, dir)) files.add(path);
    for (const target of existing) if (target.kind === 'db') files.add(target.path);
    const databases = [];
    const seen = new Set<string>();
    for (const path of files) {
      const real = await realpath(path).catch(() => path);
      if (seen.has(real)) continue;
      seen.add(real);
      databases.push(path);
    }
    return { dataDirs, databases };
  };

  return {
    name: flavour.source,

    async detect(): Promise<boolean> {
      const { dataDirs, databases } = await plan();
      if (databases.length > 0) return true;
      if (!flavour.readsJsonStorage) return false;
      for (const dir of dataDirs) if (await isDirectoryPath(join(dir, 'storage'))) return true;
      return false;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new OpenCodeAggregator({ since, timeZone: options.timeZone, flavour });
      const notes: string[] = [];
      const { dataDirs, databases } = await plan();

      if (flavour.readsJsonStorage) {
        for (const dataDir of dataDirs) {
          const storageDir = join(dataDir, 'storage');
          if (await isDirectoryPath(storageDir)) await readOpenCodeStorage(storageDir, aggregator, since.getTime());
        }
      }

      if (databases.length > 0) {
        const DatabaseSync = await loadSqlite();
        if (!DatabaseSync) {
          notes.push(
            `${flavour.displayName} needs Node 22.13+ to read ${flavour.dbFileName} (this is Node ${process.versions.node}); ${flavour.displayName} usage was skipped`,
          );
        } else {
          for (const path of databases) {
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
