import type { ModelDayRow } from '../graph-days.js';
import { displayModelName, makerOfIds, type Maker } from '../model-makers.js';
import { addCounts, emptyCounts, weightedTokens, type TokenCounts } from '../tokens.js';
import { modelColors, modelLabel, OTHER_COLOR } from './model-colors.js';
import type { RangeWindow } from './range.js';

/** One model's usage on one day, summed across devices and sources. */
export interface ModelDayTotals extends ModelDayRow {}

export interface ModelShare {
  /** What the model's rows merge on (`modelLabel`): also the key of the model filter and the cost rows. */
  label: string;
  /** Friendly name for display, e.g. "Claude Sonnet 5.5". */
  name: string;
  maker: Maker | null;
  /** Every model id merged into this row, such as dated snapshots of the same model. */
  ids: string[];
  counts: TokenCounts;
  weighted: number;
  /** Fraction of all weighted tokens in the window. */
  share: number;
  /** Theme colour by rank in the list (heaviest first), not by model. */
  color: string;
}

export interface Segment {
  label: string;
  color: string;
  value: number;
  share: number;
}

export function inWindow(date: string, window: RangeWindow): boolean {
  return date >= window.startDate && date <= window.endDate;
}

/**
 * One row per model, heaviest first (ties by name), whatever the range. Only ids that are the same
 * model merge (dated snapshots); different versions stay apart. Colours go by rank.
 */
export function modelBreakdown(rows: readonly ModelDayTotals[], window: RangeWindow): ModelShare[] {
  const byLabel = new Map<string, { ids: Set<string>; counts: TokenCounts }>();
  for (const row of rows) {
    if (!inWindow(row.date, window)) continue;
    const label = modelLabel(row.model);
    const entry = byLabel.get(label) ?? { ids: new Set<string>(), counts: emptyCounts() };
    entry.ids.add(row.model);
    entry.counts = addCounts(entry.counts, row);
    byLabel.set(label, entry);
  }

  const models = [...byLabel]
    .map(([label, { ids, counts }]) => {
      const sortedIds = [...ids].sort();
      return {
        label,
        name: displayModelName(label),
        maker: makerOfIds(sortedIds),
        ids: sortedIds,
        counts,
        weighted: weightedTokens(counts),
      };
    })
    .sort((a, b) => b.weighted - a.weighted || a.name.localeCompare(b.name) || a.label.localeCompare(b.label));

  const total = models.reduce((sum, model) => sum + model.weighted, 0);
  const colors = modelColors(models.map((model) => ({ label: model.label, maker: model.maker })));
  return models.map((model) => ({
    ...model,
    share: total > 0 ? model.weighted / total : 0,
    color: colors.get(model.label) ?? OTHER_COLOR,
  }));
}

/** One bar segment per model, in the same order as the rows. */
export function modelSegments(models: readonly ModelShare[]): Segment[] {
  return models.map((model) => ({ label: model.name, color: model.color, value: model.weighted, share: model.share }));
}

export function sumCounts(items: readonly { counts: TokenCounts }[]): TokenCounts {
  return items.reduce((sum, item) => addCounts(sum, item.counts), emptyCounts());
}

export const TOKEN_TYPES = [
  { key: 'inputTokens', label: 'Input', color: '#fca5a5' },
  { key: 'outputTokens', label: 'Output', color: '#dc2626' },
  { key: 'cacheCreationTokens', label: 'Cache write', color: '#991b1b' },
  { key: 'cacheReadTokens', label: 'Cache read', color: '#a8a29e' },
] as const satisfies readonly { key: keyof TokenCounts; label: string; color: string }[];

/** Raw counts, not weighted: the point is to see how much of the context came from cache. */
export function tokenTypeSegments(counts: TokenCounts): Segment[] {
  const total = TOKEN_TYPES.reduce((sum, type) => sum + counts[type.key], 0);
  return TOKEN_TYPES.map((type) => ({
    label: type.label,
    color: type.color,
    value: counts[type.key],
    share: total > 0 ? counts[type.key] / total : 0,
  }));
}

/** Share of prompt tokens served from cache rather than sent fresh or written to cache. */
export function cacheHitRate(counts: TokenCounts): number | null {
  const prompt = counts.inputTokens + counts.cacheCreationTokens + counts.cacheReadTokens;
  return prompt > 0 ? counts.cacheReadTokens / prompt : null;
}

export function formatShare(share: number): string {
  if (share > 0 && share < 0.001) return '<0.1%';
  return `${(share * 100).toFixed(1)}%`;
}
