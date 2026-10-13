import type { GraphDay } from './graph.js';
import { MODEL_FAMILIES, modelFamily, type ModelFamily } from './model-makers.js';
import { CACHE_READ_WEIGHT, weightedTokens, type TokenCounts } from './tokens.js';
import type { DailyModelUsage } from './types.js';

export const GRAPH_WINDOW_DAYS = 372;

/** One model's raw token counts on one day. */
export interface ModelDayRow {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Ledger usage (any number of sources and machines) as per-model day rows; tiers and the cache split fold away. */
export function usageToModelRows(usage: readonly DailyModelUsage[]): ModelDayRow[] {
  return usage.map((entry) => ({
    date: entry.date,
    model: entry.model,
    inputTokens: entry.counts.inputTokens,
    outputTokens: entry.counts.outputTokens,
    cacheCreationTokens: entry.counts.cacheCreationTokens,
    cacheReadTokens: entry.counts.cacheReadTokens,
  }));
}

/** A graph day that also names the model family behind its hue. */
export interface FamilyGraphDay extends GraphDay {
  topFamily: ModelFamily | null;
}

const EMPTY: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

function add(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** Unrounded, so a tiny day split across families still has a winner (weightedTokens rounds). */
function unroundedWeight(c: TokenCounts): number {
  return c.inputTokens + c.outputTokens + c.cacheCreationTokens + CACHE_READ_WEIGHT * c.cacheReadTokens;
}

/**
 * One graph day per date from per-model rows. The day's weight comes from its summed raw counts
 * (so it matches the plain daily totals exactly); per-family weights only decide which hue wins,
 * ties going to the earlier family in MODEL_FAMILIES.
 */
export function toGraphDaysByFamily(rows: readonly ModelDayRow[]): FamilyGraphDay[] {
  const days = new Map<string, { counts: TokenCounts; byFamily: Map<ModelFamily, TokenCounts> }>();
  for (const row of rows) {
    let day = days.get(row.date);
    if (!day) {
      day = { counts: EMPTY, byFamily: new Map() };
      days.set(row.date, day);
    }
    const family = modelFamily(row.model);
    day.counts = add(day.counts, row);
    day.byFamily.set(family, add(day.byFamily.get(family) ?? EMPTY, row));
  }
  return [...days.entries()]
    .map(([date, day]) => {
      let topFamily: ModelFamily | null = null;
      let topWeight = 0;
      for (const family of MODEL_FAMILIES) {
        const counts = day.byFamily.get(family);
        const weight = counts ? unroundedWeight(counts) : 0;
        if (weight > topWeight) {
          topWeight = weight;
          topFamily = family;
        }
      }
      return { date, weighted: weightedTokens(day.counts), topFamily };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** A client ahead of UTC may already have usage for "tomorrow"; the grid should show it. */
export function graphEndDate(todayUtc: string, dates: readonly string[]): string {
  return dates.reduce((latest, date) => (date > latest ? date : latest), todayUtc);
}
