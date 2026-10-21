import {
  addSplitCounts,
  longContextThreshold,
  maxSplitCounts,
  PRICING_TIERS,
  type DailyModelUsage,
  type PricingTier,
  type SplitTokenCounts,
} from '@tokengraph/core';

/** One upstream API request's usage, already normalised to tokengraph's four counters. */
export interface RequestRecord {
  date: string;
  model: string;
  pricingTier: PricingTier;
  counts: SplitTokenCounts;
}

/**
 * Collects requests keyed by a source's stable request id. The same request is often seen more
 * than once (a file rewritten or copied, a session forked, a record migrated between stores);
 * copies are merged with a per-field max so a request is counted once, at its most complete
 * snapshot. The first copy's date and model win, so a later copy cannot move a request.
 */
export class RequestBuckets {
  private readonly requests = new Map<string, RequestRecord>();

  add(key: string, record: RequestRecord): void {
    const existing = this.requests.get(key);
    this.requests.set(key, existing ? { ...existing, counts: maxSplitCounts(existing.counts, record.counts) } : record);
  }

  get size(): number {
    return this.requests.size;
  }

  /** Distinct requests per date. */
  requestsByDate(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { date } of this.requests.values()) counts.set(date, (counts.get(date) ?? 0) + 1);
    return counts;
  }

  toUsage(): DailyModelUsage[] {
    const buckets = new Map<string, DailyModelUsage>();
    for (const { date, model, pricingTier, counts } of this.requests.values()) {
      const key = `${date}\0${model}\0${pricingTier}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.counts = addSplitCounts(existing.counts, counts);
      } else {
        // Seeded from a copy: adding to emptySplitCounts() would turn the null cache split into 0.
        buckets.set(key, { date, model, pricingTier, counts: { ...counts } });
      }
    }
    return [...buckets.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.model.localeCompare(b.model) ||
        PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
    );
  }
}

/**
 * The tier one request is billed at. Long context is decided by the whole prompt (input, cache
 * reads and cache writes) and over the model's own threshold (`longContextThreshold`: 272K for
 * OpenAI, 200K for Gemini and xAI, 100K for Claude Haiku 5.5). Fast mode only
 * where the source records it (Claude Code's usage.speed); no other provider's rule is recorded.
 */
export function tierForModel(model: string, counts: SplitTokenCounts, fast = false): PricingTier {
  const threshold = longContextThreshold(model);
  const promptTokens = counts.inputTokens + counts.cacheReadTokens + counts.cacheCreationTokens;
  const long = threshold !== null && promptTokens > threshold;
  if (fast) return long ? 'fast-long-context' : 'fast';
  return long ? 'long-context' : 'standard';
}
