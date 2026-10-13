import { mkdir, writeFile } from 'node:fs/promises';
import {
  addCounts,
  addDays,
  dateKey,
  emptyCounts,
  formatTokens,
  renderPublishedGraphs,
  weightedTokens,
  type DailyModelUsage,
  type Theme,
  type TokenCounts,
} from '@tokengraph/core';
import { collectLocal, defaultAdapters, noAgentsMessage } from '../collect-local.js';
import { allLedgerUsage, ledgerToUsage, readLedger, writeLedger } from '../ledger.js';
import { configHome, ledgerPath } from '../paths.js';
import { acquireSyncLock } from '../sync-lock.js';

/** What started a sync: the user, the Claude Code hook, or a scheduled run. */
export type SyncTrigger = 'manual' | 'hook' | 'schedule';

export interface SyncOptions {
  sinceDays: number;
  /** Update the ledger only, never publish (`--local`). */
  local?: boolean;
  svgPath?: string;
  theme: Theme;
  /** Defaults to 'manual'. */
  trigger?: SyncTrigger;
}

export interface DayTotal {
  date: string;
  counts: TokenCounts;
  weighted: number;
}

export function summariseByDay(usage: readonly DailyModelUsage[]): DayTotal[] {
  const byDate = new Map<string, TokenCounts>();
  for (const entry of usage) {
    byDate.set(entry.date, addCounts(byDate.get(entry.date) ?? emptyCounts(), entry.counts));
  }
  return [...byDate.entries()]
    .map(([date, counts]) => ({ date, counts, weighted: weightedTokens(counts) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function runSync(options: SyncOptions): Promise<number> {
  // Held for the whole run (--local too — it writes the ledger) so two sessions ending at once
  // don't race on state.json. Skipping is success: the running sync covers the same data.
  const lock = await acquireSyncLock();
  if (!lock.acquired) {
    console.error(`Another tokengraph sync is already running${lock.pid ? ` (pid ${lock.pid})` : ''}; skipping.`);
    return 0;
  }
  try {
    return await runSyncLocked(options);
  } finally {
    await lock.release();
  }
}

async function runSyncLocked(options: SyncOptions): Promise<number> {
  const since = addDays(new Date(), -options.sinceDays);
  const sinceKey = dateKey(since);

  const before = await readLedger(ledgerPath());
  // The order each adapter finished in, so failures print between the successes exactly where they happened.
  const outcomes: ('done' | 'failed')[] = [];
  const { ledger, results: collected, failures, detected } = await collectLocal(before, since, {
    adapters: defaultAdapters(),
    onProgress: (progress) => {
      if (progress.state !== 'scanning') outcomes.push(progress.state);
    },
  });
  if (detected.length === 0) {
    console.error(noAgentsMessage());
    return 1;
  }

  let nextResult = 0;
  let nextFailure = 0;
  for (const outcome of outcomes) {
    if (outcome === 'failed') {
      const failure = failures[nextFailure++]!;
      console.log(`source: ${failure.adapter}`);
      console.log(`  note: could not be read (${failure.message})`);
      continue;
    }
    const result = collected[nextResult++]!;
    const hadHistory = Object.keys(before.sources[result.source] ?? {}).length > 0;
    const days = summariseByDay(ledgerToUsage(ledger, result.source, sinceKey));
    const recovered = days.length - summariseByDay(result.usage).length;
    console.log(`source: ${result.source}`);
    console.log(`  distinct API requests read: ${result.requestCount}`);
    console.log(`  active days: ${days.length}`);
    if (hadHistory && recovered > 0) {
      console.log(`  (${recovered} of them survive only in the local ledger — their transcripts have been pruned)`);
    }
    for (const note of result.notes ?? []) console.log(`  note: ${note}`);
  }
  await mkdir(configHome(), { recursive: true, mode: 0o700 });
  await writeLedger(ledgerPath(), ledger);

  const days = summariseByDay(allLedgerUsage(ledger, sinceKey));
  console.log(`\nwindow: ${sinceKey} .. ${dateKey(new Date())} (${options.sinceDays} days), all agents`);
  for (const day of days.slice(-14)) {
    console.log(
      `  ${day.date}  ${formatTokens(day.weighted).padStart(8)}  ` +
        `(in ${formatTokens(day.counts.inputTokens)}, out ${formatTokens(day.counts.outputTokens)}, ` +
        `cache-write ${formatTokens(day.counts.cacheCreationTokens)}, cache-read ${formatTokens(day.counts.cacheReadTokens)})`,
    );
  }
  const total = days.reduce((sum, day) => sum + day.weighted, 0);
  console.log(`\ntotal weighted tokens: ${formatTokens(total)}`);
  console.log(`ledger: ${ledgerPath()}`);

  if (options.svgPath) {
    const files = renderPublishedGraphs(allLedgerUsage(ledger), { today: dateKey(new Date()), colors: 'model' });
    await writeFile(options.svgPath, files[options.theme === 'dark' ? 'tokengraph-dark.svg' : 'tokengraph-light.svg'], 'utf8');
    console.log(`wrote ${options.svgPath}`);
  }

  if (!options.local) {
    console.log('\nSaved locally. Run `tokengraph login` to put this graph in your GitHub README.');
  }
  return 0;
}
