import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CODEX_CLI_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { envPath, FileDeduper, pathFor, planScan, processRootContext, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { jsonlFiles, readLines } from '../jsonl-files.js';
import { CodexUsageAggregator, type CodexAggregatorOptions, type CodexDiagnostics } from './aggregator.js';
import { CODEX_ROOTS } from './roots.js';

/** The Codex home this process's environment names, else `~/.codex`. An empty `CODEX_HOME` is unset, as in Codex. */
export function codexHome(): string {
  const ctx = processRootContext();
  return envPath(ctx, 'CODEX_HOME') ?? pathFor(ctx.platform).join(ctx.home, '.codex');
}

export function codexSessionsDir(): string {
  return join(codexHome(), 'sessions');
}

function describeDiagnostics({ fallbackEvents, malformedEvents, clampedEvents }: CodexDiagnostics): string[] {
  const notes: string[] = [];
  if (malformedEvents > 0) notes.push(`skipped ${malformedEvents} usage record(s) with missing counts`);
  if (fallbackEvents > 0) {
    notes.push(`${fallbackEvents} usage event(s) came from older Codex rollouts, which cannot be deduplicated`);
  }
  if (clampedEvents > 0) notes.push(`${clampedEvents} event(s) reported more cached than total input; counted as 0 fresh input`);
  return notes;
}

export interface CodexAdapterOptions extends Pick<CodexAggregatorOptions, 'timeZone'>, RootsOption {}

/**
 * Reads the rollouts under every Codex home (`$CODEX_HOME`, `~/.codex`, remembered ones): live and
 * archived sessions only. A rollout reached twice is read once (real-path dedup of roots and files),
 * which matters for older rollouts that carry no `response_id` to dedup by.
 */
export function createCodexAdapter(adapterOptions: CodexAdapterOptions = {}): Adapter {
  const { roots, ...options } = adapterOptions;
  const sessionDirs = async (): Promise<string[]> => {
    const { ctx, remembered } = await resolveAdapterRoots(CODEX_ROOTS, roots);
    return (await planScan(CODEX_ROOTS, ctx, remembered)).filter((target) => target.exists).map((target) => target.path);
  };

  return {
    name: CODEX_CLI_SOURCE,

    async detect(): Promise<boolean> {
      return (await sessionDirs()).length > 0;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new CodexUsageAggregator({ ...options, since });
      const files = new FileDeduper();
      for (const dir of await sessionDirs()) {
        for await (const path of jsonlFiles(dir)) {
          // A file last written before the cutoff cannot hold records after it.
          const info = await stat(path).catch(() => null);
          if (!info || info.mtime < since) continue;
          if (!(await files.first(path))) continue;
          aggregator.beginFile();
          await readLines(path, (line) => aggregator.addLine(line));
          aggregator.endFile();
        }
      }
      const notes = describeDiagnostics(aggregator.diagnostics());
      return { ...aggregator.result(), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
