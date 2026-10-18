import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { GOOSE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { loadSqlite as defaultLoadSqlite } from '../opencode/sqlite.js';
import { GooseUsageAggregator, type GooseAggregatorOptions } from './aggregator.js';
import { readLedger } from './sqlite.js';

const DB_PARTS = ['sessions', 'sessions.db'] as const;

/**
 * Where `sessions.db` may live, best first. An absolute `$GOOSE_PATH_ROOT` is authoritative
 * (`<root>/data`). Otherwise Goose uses its XDG data dir (`$XDG_DATA_HOME/goose`, else
 * `~/.local/share/goose`, on macOS too; `%APPDATA%\Block\goose\data` on Windows), and older builds
 * left databases in the three legacy folders after it.
 */
export function gooseDbCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const root = process.env['GOOSE_PATH_ROOT'];
  if (root && isAbsolute(root)) return [join(root, 'data', ...DB_PARTS)];
  const home = homedir();
  if (platform === 'win32') {
    const appData = process.env['APPDATA'];
    return [join(appData ? appData : join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'data', ...DB_PARTS)];
  }
  const xdg = process.env['XDG_DATA_HOME'];
  const dataHome = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
  return [
    join(dataHome, 'goose', ...DB_PARTS),
    join(home, 'Library', 'Application Support', 'goose', ...DB_PARTS),
    join(home, 'Library', 'Application Support', 'Block', 'goose', ...DB_PARTS),
    join(home, '.local', 'share', 'Block', 'goose', ...DB_PARTS),
  ];
}

/** The first candidate that exists, or null. Later candidates are older locations; an earlier database shadows them. */
async function existingDb(): Promise<string | null> {
  for (const candidate of gooseDbCandidates()) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not there; try the next location.
    }
  }
  return null;
}

export interface GooseAdapterOptions extends Pick<GooseAggregatorOptions, 'timeZone'> {
  /** Overrides `loadSqlite`, so tests can simulate a Node build without `node:sqlite`. */
  loadSqlite?: () => Promise<typeof DatabaseSync | null>;
}

/**
 * Reads Goose's per-request `usage_ledger` from `sessions.db`. Only counters, ids, the model name,
 * the timestamp and each session's provider name are selected: never messages, working
 * directories or session names. The `sessions.accumulated_*` totals describe the same requests
 * and are not read.
 */
export function createGooseAdapter(options: GooseAdapterOptions = {}): Adapter {
  const loadSqlite = options.loadSqlite ?? defaultLoadSqlite;

  return {
    name: GOOSE_SOURCE,

    async detect(): Promise<boolean> {
      return (await existingDb()) !== null;
    },

    async collect(since: Date): Promise<CollectResult> {
      const notes: string[] = [];
      const path = await existingDb();
      const aggregator = new GooseUsageAggregator({ since, timeZone: options.timeZone, dbKey: path ?? '' });

      if (path !== null) {
        const DatabaseSync = await loadSqlite();
        if (!DatabaseSync) {
          notes.push(`Goose needs Node 22.13+ to read sessions.db (this is Node ${process.versions.node}); Goose usage was skipped`);
        } else {
          try {
            const read = readLedger(DatabaseSync, path);
            if (read.kind === 'rows') for (const row of read.rows) aggregator.addRow(row);
            else notes.push(`Goose's sessions.db has an unrecognised schema (${read.reason}); Goose usage was skipped`);
          } catch {
            notes.push("Goose's sessions.db could not be read");
          }
        }
      }

      const { malformedRows, carriedForwardRows, negativeInputRows, noModelRows } = aggregator.diagnostics();
      if (carriedForwardRows > 0) {
        notes.push(`skipped ${carriedForwardRows} Goose carried-forward row(s): usage from before Goose kept a per-request ledger, with no known day or model`);
      }
      if (malformedRows > 0) notes.push(`skipped ${malformedRows} Goose record(s) with invalid token counts or timestamp`);
      if (negativeInputRows > 0) notes.push(`skipped ${negativeInputRows} Goose request(s) whose cached tokens exceeded their input (the split is unknown)`);
      if (noModelRows > 0) notes.push(`skipped ${noModelRows} Goose request(s) with no model name`);
      return { ...aggregator.result(), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
