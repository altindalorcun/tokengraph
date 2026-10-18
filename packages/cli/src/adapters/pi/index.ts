import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PI_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { jsonlFiles, readLines } from '../jsonl-files.js';
import { PiUsageAggregator, type PiAggregatorOptions } from './aggregator.js';

/** pi expands a leading `~` in its path settings; so does this. */
function expandTilde(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** `$PI_CODING_AGENT_DIR` when set, else `~/.pi/agent` (the same on every OS). */
export function piAgentDir(): string {
  const override = process.env['PI_CODING_AGENT_DIR'];
  return override ? expandTilde(override) : join(homedir(), '.pi', 'agent');
}

/**
 * Where session files live: `$PI_CODING_AGENT_SESSION_DIR` when set (sessions saved before it was
 * set stay in the default folder, so both are read), and `<agent dir>/sessions`. The `sessionDir`
 * setting and the `--session-dir` flag cannot be seen from a later sync, so they are not followed.
 */
export function piSessionDirs(): string[] {
  const defaultDir = join(piAgentDir(), 'sessions');
  const override = process.env['PI_CODING_AGENT_SESSION_DIR'];
  const dirs = override ? [expandTilde(override), defaultDir] : [defaultDir];
  return [...new Set(dirs)];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads the pi coding agent's session files (`sessions/--<cwd>--/<time>_<id>.jsonl`). Only usage
 * counters, the provider, model, response id and timestamps are read from a line; message text and
 * working directories are never kept.
 */
export function createPiAdapter(options: Pick<PiAggregatorOptions, 'timeZone'> = {}): Adapter {
  return {
    name: PI_SOURCE,

    async detect(): Promise<boolean> {
      for (const dir of piSessionDirs()) if (await isDirectory(dir)) return true;
      return false;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new PiUsageAggregator({ ...options, since });
      for (const dir of piSessionDirs()) {
        for await (const path of jsonlFiles(dir)) {
          // A file last written before the cutoff cannot hold requests after it.
          const info = await stat(path).catch(() => null);
          if (!info || info.mtime < since) continue;
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
