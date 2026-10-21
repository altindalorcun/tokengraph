/**
 * The rate class a provider bills one request at. It is decided per request (a long prompt, a
 * fast-mode session), so it has to travel with the daily totals: once requests are summed into
 * a day there is no telling which of them crossed a threshold.
 */
export const PRICING_TIERS = ['standard', 'long-context', 'fast', 'fast-long-context'] as const;
export type PricingTier = (typeof PRICING_TIERS)[number];

export const DEFAULT_PRICING_TIER: PricingTier = 'standard';

/**
 * OpenAI bills a request whose input exceeds this many tokens at long-context rates, for the whole
 * request. It is the default: a model's own rate entry can set another threshold (`longContextThreshold`).
 */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

export function pricingTierFor({
  fast,
  inputTokens,
  thresholdTokens = LONG_CONTEXT_THRESHOLD_TOKENS,
}: {
  fast: boolean;
  inputTokens: number;
  /** The model's own long-context threshold (`longContextThreshold`); OpenAI's 272K when omitted. */
  thresholdTokens?: number;
}): PricingTier {
  const long = inputTokens > thresholdTokens;
  if (fast) return long ? 'fast-long-context' : 'fast';
  return long ? 'long-context' : 'standard';
}

export function isPricingTier(value: string): value is PricingTier {
  return (PRICING_TIERS as readonly string[]).includes(value);
}
