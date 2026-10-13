import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CODE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { jsonlFiles, readLines } from '../jsonl-files.js';
import { UsageAggregator, type AggregatorOptions } from './aggregator.js';

export function projectsDir(): string {
  return join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects');
}

export function createClaudeCodeAdapter(options: Pick<AggregatorOptions, 'timeZone'> = {}): Adapter {
  return {
    name: CLAUDE_CODE_SOURCE,

    async detect(): Promise<boolean> {
      try {
        return (await stat(projectsDir())).isDirectory();
      } catch {
        return false;
      }
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new UsageAggregator({ ...options, since });
      for await (const path of jsonlFiles(projectsDir())) {
        // A file last written before the cutoff cannot hold records after it.
        const info = await stat(path).catch(() => null);
        if (!info || info.mtime < since) continue;
        await readLines(path, (line) => aggregator.addLine(line));
      }
      return aggregator.result(CLAUDE_CODE_SOURCE);
    },
  };
}
