import { dateKey } from '../dates.js';
import type { ModelDayRow } from '../graph-days.js';
import type { CostRow } from './cost.js';
import { buildStory, type StoryData } from './data.js';
import { DEMO_HANDLE, demoUsage } from './demo-usage.js';
import type { StoryRange } from './options.js';
import { shiftDate } from './range.js';

/** How far back the demo looks for a day worth showing off as "today". */
const LOOKBACK = 14;
/** The streak that day must end, so the sample graph's streak is not a lone day after a weekend off. */
const MIN_STREAK = 3;

/**
 * The made-up demo account as story rows (used for the sample cards in the README). The demo year skips days at random, so its
 * real today is often empty; the whole year is slid forward so the heaviest of its last two weeks that ends a streak of at
 * least three days lands on today, and the sample card is always worth showing. Still never real data.
 */
export function demoStoryRows(now: Date): { rows: ModelDayRow[]; costRows: CostRow[]; todayUtc: string } {
  const todayUtc = dateKey(now, 'UTC');
  const { modelRows } = demoUsage(now);
  const totals = new Map<string, number>();
  for (const row of modelRows) {
    const weighted = row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens * 0.1;
    totals.set(row.date, (totals.get(row.date) ?? 0) + weighted);
  }
  const since = shiftDate(todayUtc, -(LOOKBACK - 1));
  let best = todayUtc;
  let bestWeight = -1;
  const endsStreak = (date: string): boolean =>
    Array.from({ length: MIN_STREAK }, (_, back) => totals.get(shiftDate(date, -back)) ?? 0).every((weighted) => weighted > 0);
  for (const [date, weighted] of totals) {
    if (date >= since && date <= todayUtc && weighted > bestWeight && endsStreak(date)) {
      best = date;
      bestWeight = weighted;
    }
  }
  const offset = Math.round((Date.parse(`${todayUtc}T00:00:00Z`) - Date.parse(`${best}T00:00:00Z`)) / 86_400_000);
  // Days after the chosen one would land in the future; they are dropped.
  const rows = modelRows.map((row) => ({ ...row, date: shiftDate(row.date, offset) })).filter((row) => row.date <= todayUtc);
  // Priced as standard tier with every cache write at the 5-minute rate, so the demo shows a cost.
  const costRows: CostRow[] = rows.map((row) => ({
    date: row.date,
    model: row.model,
    pricingTier: 'standard',
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheCreation5mTokens: row.cacheCreationTokens,
    cacheCreation1hTokens: 0,
  }));
  return { rows, costRows, todayUtc };
}

export function demoStory(range: StoryRange, now: Date): StoryData {
  const { rows, costRows, todayUtc } = demoStoryRows(now);
  return buildStory({ handle: DEMO_HANDLE, range, todayUtc, rows, costRows, demo: true });
}
