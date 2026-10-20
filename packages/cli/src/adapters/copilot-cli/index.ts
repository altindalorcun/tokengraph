import type { DatabaseSync } from 'node:sqlite';
import { COPILOT_CLI_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { envPath, pathFor, planScan, processRootContext, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { loadSqlite as defaultLoadSqlite } from '../opencode/sqlite.js';
import { CopilotUsageAggregator, type CopilotAggregatorOptions } from './aggregator.js';
import { COPILOT_ROOTS } from './roots.js';
import { readUsageEvents } from './sqlite.js';

/** `$COPILOT_HOME` (trimmed, `~` expanded, absolute) when this process's environment sets it, else `~/.copilot` (the same on every OS). A `--config-dir` flag given to one run cannot be seen from here. */
export function copilotHome(): string {
  const ctx = processRootContext();
  return envPath(ctx, 'COPILOT_HOME') ?? pathFor(ctx.platform).join(ctx.home, '.copilot');
}

export interface CopilotCliAdapterOptions extends Pick<CopilotAggregatorOptions, 'timeZone'>, RootsOption {
  /** Overrides `loadSqlite`, so tests can simulate a Node build without `node:sqlite`. */
  loadSqlite?: () => Promise<typeof DatabaseSync | null>;
}

/**
 * Reads GitHub Copilot CLI's per-request usage from `session-store.db` (table
 * `assistant_usage_events`, written by Copilot CLI 1.0.70+). Only counters, ids, the model name and
 * the timestamp are selected: never prompts, working directories or session summaries. The
 * `events.jsonl` snapshots, the opt-in OTEL file and the Copilot Chat extension in VS Code
 * describe the same requests and are not read.
 */
export function createCopilotCliAdapter(options: CopilotCliAdapterOptions = {}): Adapter {
  const loadSqlite = options.loadSqlite ?? defaultLoadSqlite;
  /** Every `session-store.db` that exists, each real file once. */
  const stores = async (): Promise<string[]> => {
    const { ctx, remembered } = await resolveAdapterRoots(COPILOT_ROOTS, options.roots);
    return (await planScan(COPILOT_ROOTS, ctx, remembered)).filter((target) => target.exists).map((target) => target.path);
  };

  return {
    name: COPILOT_CLI_SOURCE,

    async detect(): Promise<boolean> {
      return (await stores()).length > 0;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new CopilotUsageAggregator({ since, timeZone: options.timeZone });
      const notes: string[] = [];

      const paths = await stores();
      if (paths.length > 0) {
        const DatabaseSync = await loadSqlite();
        if (!DatabaseSync) {
          notes.push(`Copilot CLI needs Node 22.13+ to read session-store.db (this is Node ${process.versions.node}); Copilot CLI usage was skipped`);
        } else {
          // Rows are keyed by session id plus row id: another profile's database has other session ids, a copy of one collapses.
          for (const path of paths) {
            try {
              const read = readUsageEvents(DatabaseSync, path);
              if (read.kind === 'rows') for (const row of read.rows) aggregator.addRow(row);
              else notes.push(`Copilot CLI's session-store.db has an unrecognised schema (${read.reason}); Copilot CLI usage was skipped`);
            } catch {
              notes.push("Copilot CLI's session-store.db could not be read");
            }
          }
        }
      }

      const { malformedRows, clampedRows } = aggregator.diagnostics();
      if (malformedRows > 0) notes.push(`skipped ${malformedRows} Copilot CLI record(s) with missing or invalid token counts, session id or timestamp`);
      if (clampedRows > 0) notes.push(`${clampedRows} Copilot CLI request(s) reported more cached than total input; counted as 0 fresh input`);
      return { ...aggregator.result(), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
