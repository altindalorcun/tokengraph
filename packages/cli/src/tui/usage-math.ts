import { addDays, cacheSavingsForSplitCounts, costForSplitCounts, weightedTokens, type PricingTier, type SplitTokenCounts } from '@tokengraph/core';

export type RangeKey = '7d' | '30d' | '90d' | '1y' | 'all';
export const RANGES: readonly RangeKey[] = ['7d', '30d', '90d', '1y', 'all'];
export const RANGE_LABELS: Record<RangeKey, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
  all: 'All time',
};

export const SERIES_DAYS = 30;

export interface CostSummary {
  dollars: number;
  pricedWeighted: number;
  unpricedWeighted: number;
  /** Dollars prompt caching saved against full input price, over priced rows. */
  cacheSaved: number;
}

export function emptyCost(): CostSummary {
  return { dollars: 0, pricedWeighted: 0, unpricedWeighted: 0, cacheSaved: 0 };
}

export function addCost(a: CostSummary, b: CostSummary): CostSummary {
  return {
    dollars: a.dollars + b.dollars,
    pricedWeighted: a.pricedWeighted + b.pricedWeighted,
    unpricedWeighted: a.unpricedWeighted + b.unpricedWeighted,
    cacheSaved: a.cacheSaved + b.cacheSaved,
  };
}

/** The cost of one ledger row. An unpriced model is counted as unpriced, never as $0. */
export function rowCost(model: string, date: string, counts: SplitTokenCounts, tier: PricingTier): CostSummary {
  const priced = costForSplitCounts(model, date, counts, tier);
  const weighted = weightedTokens(counts);
  return priced.priced
    ? { dollars: priced.dollars, pricedWeighted: weighted, unpricedWeighted: 0, cacheSaved: cacheSavingsForSplitCounts(model, date, counts, tier) ?? 0 }
    : { dollars: 0, pricedWeighted: 0, unpricedWeighted: weighted, cacheSaved: 0 };
}

export function shiftDate(date: string, days: number): string {
  return addDays(new Date(`${date}T00:00:00Z`), days).toISOString().slice(0, 10);
}

/** First day of a range (inclusive), or null for 'all'. */
export function rangeStart(range: RangeKey, today: string): string | null {
  switch (range) {
    case '7d':
      return shiftDate(today, -6);
    case '30d':
      return shiftDate(today, -29);
    case '90d':
      return shiftDate(today, -89);
    case '1y':
      return shiftDate(today, -364);
    case 'all':
      return null;
  }
}
