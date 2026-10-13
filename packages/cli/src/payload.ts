import {
  DEFAULT_PRICING_TIER,
  weightedTokens,
  type DailyModelUsage,
  type KnownSource,
  type ModelUsage,
  type UsagePayload,
} from '@tokengraph/core';

// Mirrors the server's schema limits; one out-of-range entry would get the whole upload
// rejected on every sync, so such entries are trimmed here instead.
const MAX_MODEL_NAME_LENGTH = 120;
const MAX_MODELS_PER_DAY = 50;

/** True for a value that is either null (an unknown 5m/1h split, which is allowed) or a non-negative integer. */
function isValidNullableCount(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 0);
}

/**
 * A boundary guard against a ledger entry that reached this point with a count that isn't a
 * non-negative integer — a bug upstream (an adapter or the ledger's own max-merge) rather than
 * something expected here, but one bad entry would otherwise get the whole day's upload rejected
 * by the server's schema on every sync, forever. The 5m/1h split may legitimately be null.
 */
function hasValidCounts(counts: DailyModelUsage['counts']): boolean {
  return (
    Number.isInteger(counts.inputTokens) &&
    counts.inputTokens >= 0 &&
    Number.isInteger(counts.outputTokens) &&
    counts.outputTokens >= 0 &&
    Number.isInteger(counts.cacheCreationTokens) &&
    counts.cacheCreationTokens >= 0 &&
    Number.isInteger(counts.cacheReadTokens) &&
    counts.cacheReadTokens >= 0 &&
    isValidNullableCount(counts.cacheCreation5mTokens) &&
    isValidNullableCount(counts.cacheCreation1hTokens)
  );
}

export interface BuildUsagePayloadResult {
  payload: UsagePayload | null;
  /** Entries dropped because their counts were not non-negative integers. */
  dropped: number;
}

export function buildUsagePayload(
  deviceId: string,
  source: KnownSource,
  usage: readonly DailyModelUsage[],
): BuildUsagePayloadResult {
  const byDate = new Map<string, ModelUsage[]>();
  let dropped = 0;
  for (const entry of usage) {
    if (entry.model.length === 0 || entry.model.length > MAX_MODEL_NAME_LENGTH) continue;
    if (!hasValidCounts(entry.counts)) {
      dropped += 1;
      continue;
    }
    const models = byDate.get(entry.date) ?? [];
    const { cacheCreation5mTokens, cacheCreation1hTokens, ...counts } = entry.counts;
    // Both fields are only ever null together — a pre-split ledger entry (migrated from v1/v2)
    // and every Codex row null them as a pair — so omitting them together keeps the wire schema
    // optional-only, no nullable needed.
    const split =
      cacheCreation5mTokens !== null && cacheCreation1hTokens !== null
        ? { cacheCreation5mTokens, cacheCreation1hTokens }
        : {};
    // Standard is the default on the server too, so it is left out — an older server that has not
    // learned about tiers then still accepts the payload unchanged.
    const tier = entry.pricingTier === DEFAULT_PRICING_TIER ? {} : { pricingTier: entry.pricingTier };
    models.push({ model: entry.model, ...tier, ...counts, ...split });
    byDate.set(entry.date, models);
  }
  if (byDate.size === 0) return { payload: null, dropped };

  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, models]) => ({
      date,
      models: models.sort((a, b) => weightedTokens(b) - weightedTokens(a)).slice(0, MAX_MODELS_PER_DAY),
    }));
  return { payload: { deviceId, source, days }, dropped };
}
