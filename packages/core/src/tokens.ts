export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Cache reads are typically two orders of magnitude larger than fresh tokens,
 * so they are discounted rather than dropped — otherwise every graph would
 * only show how long sessions were, not how much work happened.
 */
export const CACHE_READ_WEIGHT = 0.1;

export function weightedTokens(counts: TokenCounts): number {
  return Math.round(
    counts.inputTokens +
      counts.outputTokens +
      counts.cacheCreationTokens +
      CACHE_READ_WEIGHT * counts.cacheReadTokens,
  );
}

export function emptyCounts(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

export function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/**
 * Cache writes split by TTL, which is what real dollar cost needs (a 1h write costs
 * twice a 5m write). null means unknown for this entry, not zero: either it predates
 * cache-split capture, or the source transcript did not carry the nested breakdown.
 * Never coalesce null to 0 for cost math — see packages/core/src/pricing.ts.
 */
export interface CacheCreationSplit {
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
}

export type SplitTokenCounts = TokenCounts & CacheCreationSplit;

export function emptySplitCounts(): SplitTokenCounts {
  return { ...emptyCounts(), cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };
}

/** Null-aware max, matching how Postgres GREATEST() treats NULL: unknown+unknown stays unknown. */
export function maxNullable(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : Math.max(a ?? 0, b ?? 0);
}

function addNullable(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

export function addSplitCounts(a: SplitTokenCounts, b: SplitTokenCounts): SplitTokenCounts {
  return {
    ...addCounts(a, b),
    cacheCreation5mTokens: addNullable(a.cacheCreation5mTokens, b.cacheCreation5mTokens),
    cacheCreation1hTokens: addNullable(a.cacheCreation1hTokens, b.cacheCreation1hTokens),
  };
}

/**
 * Per-field max, used to merge duplicate copies of the same underlying event (a repeated
 * ledger sync, or a source that writes a growing usage snapshot multiple times under one
 * id before the final one) into a high-water mark instead of summing double-counted totals.
 */
export function maxSplitCounts(a: SplitTokenCounts, b: SplitTokenCounts): SplitTokenCounts {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreation5mTokens: maxNullable(a.cacheCreation5mTokens, b.cacheCreation5mTokens),
    cacheCreation1hTokens: maxNullable(a.cacheCreation1hTokens, b.cacheCreation1hTokens),
  };
}
