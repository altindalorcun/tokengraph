import { stat } from 'node:fs/promises';
import { PI_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { envPath, FileDeduper, pathFor, planScan, processRootContext, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { jsonlFiles, readLines } from '../jsonl-files.js';
import { PiUsageAggregator, type PiAggregatorOptions } from './aggregator.js';
import { PI_ROOTS } from './roots.js';

/** `$PI_CODING_AGENT_DIR` (read the way pi does: `~`, `file://`) when this process's environment sets it, else `~/.pi/agent` (the same on every OS). */
export function piAgentDir(): string {
  const ctx = processRootContext();
  return envPath(ctx, 'PI_CODING_AGENT_DIR', { fileUrl: true, shellPaths: true }) ?? pathFor(ctx.platform).join(ctx.home, '.pi', 'agent');
}

/**
 * The session folders this process's environment names: `$PI_CODING_AGENT_SESSION_DIR` when set, and
 * `<agent dir>/sessions`. The adapter also reads the default agent folder and remembered ones.
 */
export function piSessionDirs(): string[] {
  const ctx = processRootContext();
  const fromEnv = PI_ROOTS.fromEnv(ctx);
  const roots = fromEnv.length > 0 ? fromEnv : [piAgentDir()];
  return [...new Set(roots.flatMap((root) => PI_ROOTS.targets(root, ctx).map((target) => target.path)))];
}

/**
 * Reads the pi coding agent's session files (`sessions/--<cwd>--/<time>_<id>.jsonl`). Only usage
 * counters, the provider, model, response id and timestamps are read from a line; message text and
 * working directories are never kept.
 */
export interface PiAdapterOptions extends Pick<PiAggregatorOptions, 'timeZone'>, RootsOption {}

export function createPiAdapter(adapterOptions: PiAdapterOptions = {}): Adapter {
  const { roots, ...options } = adapterOptions;
  const sessionDirs = async (): Promise<string[]> => {
    const { ctx, remembered } = await resolveAdapterRoots(PI_ROOTS, roots);
    return (await planScan(PI_ROOTS, ctx, remembered)).filter((target) => target.exists).map((target) => target.path);
  };

  return {
    name: PI_SOURCE,

    async detect(): Promise<boolean> {
      return (await sessionDirs()).length > 0;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new PiUsageAggregator({ ...options, since });
      const files = new FileDeduper();
      for (const dir of await sessionDirs()) {
        for await (const path of jsonlFiles(dir)) {
          // A file last written before the cutoff cannot hold requests after it.
          const info = await stat(path).catch(() => null);
          if (!info || info.mtime < since) continue;
          if (!(await files.first(path))) continue;
          await readLines(path, (line) => aggregator.addLine(line));
        }
      }

      const { malformedRecords, unattributedRecords } = aggregator.diagnostics();
      const notes: string[] = [];
      if (malformedRecords > 0) notes.push(`skipped ${malformedRecords} pi record(s) with missing or invalid token counts, model or timestamp`);
      if (unattributedRecords > 0) {
        notes.push(`skipped ${unattributedRecords} pi usage record(s) with no model (compaction, branch summary or tool result summaries); their tokens are not counted`);
      }
      return { ...aggregator.result(), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
