import type { DatabaseSync } from 'node:sqlite';
import { GOOSE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { planScan, plannedPaths, processRootContext, type RootContext, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { loadSqlite as defaultLoadSqlite } from '../opencode/sqlite.js';
import { GooseUsageAggregator, type GooseAggregatorOptions } from './aggregator.js';
import { GOOSE_ROOTS } from './roots.js';
import { readLedger } from './sqlite.js';

/**
 * Where `sessions.db` may live for this process's environment, best first: Goose's own data dir, then
 * the legacy folders older builds used (see `GOOSE_ROOTS`). The adapter reads every one that exists
 * (plus remembered ones), not just the first.
 */
export function gooseDbCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const ctx: RootContext = { ...processRootContext(), platform };
  const env = new Set(GOOSE_ROOTS.fromEnv(ctx));
  const planned = plannedPaths(GOOSE_ROOTS, ctx).map(({ root, target }) => ({ root, path: target.path }));
  // An absolute GOOSE_PATH_ROOT is authoritative for Goose itself: list its database first.
  return [...new Set([...planned.filter(({ root }) => env.has(root)), ...planned].map(({ path }) => path))];
}

export interface GooseAdapterOptions extends Pick<GooseAggregatorOptions, 'timeZone'>, RootsOption {
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
  /** Every `sessions.db` that exists, each real file once. */
  const databases = async (): Promise<string[]> => {
    const { ctx, remembered } = await resolveAdapterRoots(GOOSE_ROOTS, options.roots);
    return (await planScan(GOOSE_ROOTS, ctx, remembered)).filter((target) => target.exists).map((target) => target.path);
  };

  return {
    name: GOOSE_SOURCE,

    async detect(): Promise<boolean> {
      return (await databases()).length > 0;
    },

    async collect(since: Date): Promise<CollectResult> {
      const notes: string[] = [];
      // Rows are keyed by session and ledger id, not by the database they were read from, so a copy of one
      // database (a backup, a GOOSE_PATH_ROOT copy) collapses instead of counting twice.
      const aggregator = new GooseUsageAggregator({ since, timeZone: options.timeZone });
      const paths = await databases();

      if (paths.length > 0) {
        const DatabaseSync = await loadSqlite();
        if (!DatabaseSync) {
          notes.push(`Goose needs Node 22.13+ to read sessions.db (this is Node ${process.versions.node}); Goose usage was skipped`);
        } else {
          for (const path of paths) {
            try {
              const read = readLedger(DatabaseSync, path);
              if (read.kind === 'rows') for (const row of read.rows) aggregator.addRow(row);
              else notes.push(`Goose's sessions.db has an unrecognised schema (${read.reason}); Goose usage was skipped`);
            } catch {
              notes.push("Goose's sessions.db could not be read");
            }
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
