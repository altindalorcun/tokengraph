import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_CLI_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { jsonlFiles, readLines } from '../jsonl-files.js';
import { CodexUsageAggregator, type CodexAggregatorOptions, type CodexDiagnostics } from './aggregator.js';

export function codexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
}

export function codexSessionsDir(): string {
  return join(codexHome(), 'sessions');
}

/**
 * Live rollouts and the ones Codex has archived. Nothing else under CODEX_HOME is read — the
 * prompt history and auth files there are not usage and never leave the machine.
 */
function sessionDirs(): string[] {
  return [codexSessionsDir(), join(codexHome(), 'archived_sessions')];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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

export function createCodexAdapter(options: Pick<CodexAggregatorOptions, 'timeZone'> = {}): Adapter {
  return {
    name: CODEX_CLI_SOURCE,

    async detect(): Promise<boolean> {
      for (const dir of sessionDirs()) if (await isDirectory(dir)) return true;
      return false;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new CodexUsageAggregator({ ...options, since });
      for (const dir of sessionDirs()) {
        for await (const path of jsonlFiles(dir)) {
          // A file last written before the cutoff cannot hold records after it.
          const info = await stat(path).catch(() => null);
          if (!info || info.mtime < since) continue;
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
