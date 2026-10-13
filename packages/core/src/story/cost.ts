import { costForSplitCounts, type ModelCost } from '../pricing.js';
import type { PricingTier } from '../pricing-tiers.js';
import type { TokenCounts } from '../tokens.js';
import { inWindow } from './aggregate.js';
import { modelLabel } from './model-colors.js';
import type { RangeWindow } from './range.js';

/** One model's cost inputs on one day, summed across devices and sources. */
export interface CostRow {
  date: string;
  model: string;
  pricingTier: PricingTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** All cache writes; the 5m/1h split below is Anthropic-only and null elsewhere. */
  cacheCreationTokens: number;
  /** null means at least one contributing row predates cache-split capture — see pricing.ts. */
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
}

export function rowCost(row: CostRow): ModelCost {
  return costForSplitCounts(
    row.model,
    row.date,
    {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      cacheCreation5mTokens: row.cacheCreation5mTokens,
      cacheCreation1hTokens: row.cacheCreation1hTokens,
    },
    row.pricingTier,
  );
}

export interface ModelCostShare {
  label: string;
  ids: string[];
  tokens: TokenCounts;
  /**
   * The known portion of this model's cost in the window. Unpriced rows contribute nothing
   * here, so this is exact when `complete` is true and a partial lower bound when it's false
   * — never hidden behind a blanket "unknown" just because *some* day couldn't be priced.
   */
  dollars: number;
  /** True only when every row for this model in the window was priced — `dollars` is exact. */
  complete: boolean;
  /** True when at least one row was priced. False means `dollars` is 0 because nothing about
   * this model could be priced at all (e.g. an unrecognized model), not because it cost $0. */
  priced: boolean;
}

export interface CostBreakdown {
  totalDollars: number;
  /** False if any included model was unpriced — the UI must show totalDollars as a lower bound. */
  complete: boolean;
  /**
   * The earliest date in the window with a priced row, i.e. where cost tracking actually
   * starts for this data. null when nothing in the window is priced yet. Existing
   * users will almost always have usage before this date — that usage is not backfilled or
   * estimated, so totalDollars only ever reflects this date onward; the UI uses this to say
   * so honestly instead of a vague "partial" flag.
   */
  pricedSinceDate: string | null;
  models: ModelCostShare[];
}

function emptyTokens(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

/** Per-model dollar cost and token totals for the window, heaviest first. */
export function costBreakdown(rows: readonly CostRow[], window: RangeWindow): CostBreakdown {
  const byLabel = new Map<
    string,
    { ids: Set<string>; dollars: number; tokens: TokenCounts; complete: boolean; priced: boolean }
  >();
  let pricedSinceDate: string | null = null;

  for (const row of rows) {
    if (!inWindow(row.date, window)) continue;
    const label = modelLabel(row.model);
    const entry = byLabel.get(label) ?? {
      ids: new Set<string>(),
      dollars: 0,
      tokens: emptyTokens(),
      complete: true,
      priced: false,
    };
    entry.ids.add(row.model);

    entry.tokens = {
      inputTokens: entry.tokens.inputTokens + row.inputTokens,
      outputTokens: entry.tokens.outputTokens + row.outputTokens,
      cacheCreationTokens: entry.tokens.cacheCreationTokens + row.cacheCreationTokens,
      cacheReadTokens: entry.tokens.cacheReadTokens + row.cacheReadTokens,
    };

    const cost = rowCost(row);
    entry.dollars += cost.dollars;
    entry.complete &&= cost.priced;
    entry.priced ||= cost.priced;
    byLabel.set(label, entry);

    if (cost.priced && (pricedSinceDate === null || row.date < pricedSinceDate)) pricedSinceDate = row.date;
  }

  const models = [...byLabel]
    .map(([label, { ids, dollars, tokens, complete, priced }]) => ({
      label,
      ids: [...ids].sort(),
      dollars,
      tokens,
      complete,
      priced,
    }))
    .sort((a, b) => b.dollars - a.dollars || a.label.localeCompare(b.label));

  const totalDollars = models.reduce((sum, model) => sum + model.dollars, 0);
  const complete = models.every((model) => model.complete);
  return { totalDollars, complete, pricedSinceDate, models };
}

