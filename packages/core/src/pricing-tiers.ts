import { modelLabel } from './models.js';

/**
 * The rate class a provider bills one request at. It is decided per request (a long prompt, a
 * fast-mode session), so it has to travel with the daily totals: once requests are summed into
 * a day there is no telling which of them crossed a threshold.
 */
export const PRICING_TIERS = ['standard', 'long-context', 'fast', 'fast-long-context'] as const;
export type PricingTier = (typeof PRICING_TIERS)[number];

export const DEFAULT_PRICING_TIER: PricingTier = 'standard';

/** OpenAI bills a request whose input exceeds this many tokens at long-context rates, for the whole request. */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

/**
 * Claude models priced by prompt length: a request whose prompt (input, cache reads and cache
 * writes together) is over this many tokens pays the model's long-context rate for the whole
 * request. Every other Claude model bills its full context window at one rate.
 */
const CLAUDE_LONG_CONTEXT_THRESHOLDS: Record<string, number> = {
  'claude-haiku-5-5': 100_000,
};

export function claudeLongContextThreshold(model: string): number | null {
  return CLAUDE_LONG_CONTEXT_THRESHOLDS[modelLabel(model)] ?? null;
}

export function pricingTierFor({ fast, inputTokens }: { fast: boolean; inputTokens: number }): PricingTier {
  const long = inputTokens > LONG_CONTEXT_THRESHOLD_TOKENS;
  if (fast) return long ? 'fast-long-context' : 'fast';
  return long ? 'long-context' : 'standard';
}

export function isPricingTier(value: string): value is PricingTier {
  return (PRICING_TIERS as readonly string[]).includes(value);
}
