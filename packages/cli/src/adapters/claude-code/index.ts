import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CLAUDE_CODE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { envPath, FileDeduper, pathFor, planScan, processRootContext, type PlannedTarget, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { flatJsonlFiles, jsonlFiles, readLines } from '../jsonl-files.js';
import { UsageAggregator, type AggregatorOptions } from './aggregator.js';
import { desktopClaudeDirs } from './desktop.js';
import { CLAUDE_CODE_ROOTS } from './roots.js';

/** The `projects` folder of the Claude config folder this process's environment names (or `~/.claude`). */
export function projectsDir(): string {
  const ctx = processRootContext();
  return join(envPath(ctx, 'CLAUDE_CONFIG_DIR') ?? pathFor(ctx.platform).join(ctx.home, '.claude'), 'projects');
}

/** Claude Desktop writes `audit.jsonl` next to its sessions: another copy of the same API traffic, never usage to count. */
const isAudit = (path: string): boolean => basename(path) === 'audit.jsonl';

/** Every transcript file one planned target leads to, in no particular order. */
async function* transcriptFiles(target: PlannedTarget): AsyncGenerator<string> {
  switch (target.kind) {
    case 'projects':
      yield* jsonlFiles(target.path);
      break;
    case 'transcripts':
      for await (const path of flatJsonlFiles(target.path)) if (!isAudit(path)) yield path;
      break;
    default:
      // A Claude Desktop session folder: find the `.claude` folders in it, read each one's `projects/` and `transcripts/`.
      for await (const claudeDir of desktopClaudeDirs(target.path)) {
        for await (const path of jsonlFiles(join(claudeDir, 'projects'))) if (!isAudit(path)) yield path;
        for await (const path of flatJsonlFiles(join(claudeDir, 'transcripts'))) if (!isAudit(path)) yield path;
      }
  }
}

export interface ClaudeCodeAdapterOptions extends Pick<AggregatorOptions, 'timeZone'>, RootsOption {}

/**
 * Reads Claude Code's transcripts from every Claude config folder it can find (`~/.claude`, the one
 * `CLAUDE_CONFIG_DIR` names, remembered ones) and from Claude Desktop's Code and Cowork session
 * folders. One `message.id` is counted once however many roots, copies or resumed sessions hold it.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): Adapter {
  const { roots, ...aggregatorOptions } = options;
  const plan = async (): Promise<PlannedTarget[]> => {
    const { ctx, remembered } = await resolveAdapterRoots(CLAUDE_CODE_ROOTS, roots);
    return (await planScan(CLAUDE_CODE_ROOTS, ctx, remembered)).filter((target) => target.exists);
  };

  return {
    name: CLAUDE_CODE_SOURCE,

    async detect(): Promise<boolean> {
      for (const target of await plan()) {
        if (target.kind !== 'desktop') return true;
        for await (const claudeDir of desktopClaudeDirs(target.path)) {
          const found = (await Promise.all([stat(join(claudeDir, 'projects')), stat(join(claudeDir, 'transcripts'))].map((p) => p.catch(() => null)))).some(Boolean);
          if (found) return true;
        }
      }
      return false;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new UsageAggregator({ ...aggregatorOptions, since });
      const files = new FileDeduper();
      for (const target of await plan()) {
        for await (const path of transcriptFiles(target)) {
          // A file last written before the cutoff cannot hold records after it.
          const info = await stat(path).catch(() => null);
          if (!info || info.mtime < since) continue;
          if (!(await files.first(path))) continue;
          await readLines(path, (line) => aggregator.addLine(line));
        }
      }
      return aggregator.result(CLAUDE_CODE_SOURCE);
    },
  };
}
