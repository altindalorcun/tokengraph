import { modelLabel } from './models.js';
import { DEFAULT_PRICING_TIER, type PricingTier } from './pricing-tiers.js';
import type { SplitTokenCounts } from './tokens.js';

/** A long-context request's rates as multiples of the standard ones, for the whole request. */
export interface LongContextMultipliers {
  input: number;
  output: number;
}

export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
  /** A cache read's price as a multiple of inputPerMillion. */
  cacheReadMultiplier: number;
  /**
   * null: Anthropic-style cache writes, priced per TTL from the 5m/1h split. A number: one
   * cache-write rate at this multiple of inputPerMillion (OpenAI), with no split needed.
   */
  cacheWriteMultiplier: number | null;
  /** Long-context rates, where the model publishes them; null leaves that tier unpriced. */
  longContext: LongContextMultipliers | null;
  /** Fast mode's multiple of every rate, where the model publishes one; null leaves the fast tiers unpriced. */
  fastMultiplier: number | null;
}

interface ModelRateEntry {
  /** The rate applies to any day on or after this date, until a newer entry supersedes it. */
  effectiveFrom: string;
  inputPerMillion: number;
  outputPerMillion: number;
  /** Only set where a model's cache-read price differs from the standard CACHE_READ_COST_MULTIPLIER. */
  cacheReadMultiplier?: number;
  /** Only set for single-rate cache-write models (OpenAI, Cursor) — see ModelRate.cacheWriteMultiplier. */
  cacheWriteMultiplier?: number;
  longContext?: LongContextMultipliers;
  /**
   * Anthropic models have no fast rate unless one is set here. Single-rate models (OpenAI) default
   * to FAST_MODE_MULTIPLIER, so set this only where a published fast row is a different multiple.
   */
  fastMultiplier?: number;
}

/** OpenAI bills a long-context request (see LONG_CONTEXT_THRESHOLD_TOKENS) at these multiples, for the whole request. */
export const LONG_CONTEXT_INPUT_MULTIPLIER = 2;
export const LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;
const OPENAI_LONG_CONTEXT: LongContextMultipliers = {
  input: LONG_CONTEXT_INPUT_MULTIPLIER,
  output: LONG_CONTEXT_OUTPUT_MULTIPLIER,
};

/**
 * Keyed by the date-suffix-stripped model id (modelLabel handles both a bare alias and a
 * dated snapshot). A model missing from this table is priced as unknown, never silently at
 * $0 or at another model's rate.
 *
 * Each model holds a history of rates, not just the current one, because a day's cost must
 * reflect the price that was actually in effect when the tokens were spent — recomputing
 * history with today's rate would misrepresent what was really burned.
 *
 * TO RECORD A PRICE CHANGE: append a new entry with today's date as effectiveFrom. Never
 * edit an existing entry's numbers — that retroactively reprices every past day for that
 * model. The initial entry for each model below is dated far in the past because the exact
 * historical change dates aren't known; it is our best available baseline and applies
 * retroactively until a real dated entry supersedes it.
 */
const RATES: Record<string, ModelRateEntry[]> = {
  // Anthropic, from platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-12. Fast mode
  // (Claude Code's usage.speed) is published only for Opus 5.5, Opus 5 and Opus 4.8, at 2x every rate.
  'claude-fable-5-1': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 10, outputPerMillion: 50, cacheReadMultiplier: 0.025 },
  ],
  'claude-mythos-5-1': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 10, outputPerMillion: 50, cacheReadMultiplier: 0.025 },
  ],
  'claude-fable-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 10, outputPerMillion: 50 }],
  'claude-mythos-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 10, outputPerMillion: 50 }],
  'claude-opus-5-5': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 4, outputPerMillion: 20, cacheReadMultiplier: 0.05, fastMultiplier: 2 },
  ],
  'claude-opus-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 5, outputPerMillion: 25, fastMultiplier: 2 }],
  'claude-opus-4-8': [{ effectiveFrom: '2000-01-01', inputPerMillion: 5, outputPerMillion: 25, fastMultiplier: 2 }],
  'claude-opus-4-7': [{ effectiveFrom: '2000-01-01', inputPerMillion: 5, outputPerMillion: 25 }],
  'claude-opus-4-6': [{ effectiveFrom: '2000-01-01', inputPerMillion: 5, outputPerMillion: 25 }],
  'claude-opus-4-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 5, outputPerMillion: 25 }],
  'claude-opus-4-1': [{ effectiveFrom: '2000-01-01', inputPerMillion: 15, outputPerMillion: 75 }],
  'claude-opus-4': [{ effectiveFrom: '2000-01-01', inputPerMillion: 15, outputPerMillion: 75 }],
  'claude-sonnet-5-5': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 10 },
    // Cache reads halved to 0.05x ($0.10/M), announced 2026-10-07; nothing else changed.
    { effectiveFrom: '2026-10-07', inputPerMillion: 2, outputPerMillion: 10, cacheReadMultiplier: 0.05 },
  ],
  'claude-sonnet-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 10 }],
  'claude-sonnet-4-6': [{ effectiveFrom: '2000-01-01', inputPerMillion: 3, outputPerMillion: 15 }],
  'claude-sonnet-4-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 3, outputPerMillion: 15 }],
  'claude-sonnet-4': [{ effectiveFrom: '2000-01-01', inputPerMillion: 3, outputPerMillion: 15 }],
  // A prompt over 100K tokens (claudeLongContextThreshold) pays $0.50 / $2.50, every cache rate scaled with it.
  'claude-haiku-5-5': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 0.1, outputPerMillion: 0.5, longContext: { input: 5, output: 5 } },
  ],
  'claude-haiku-4-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1, outputPerMillion: 5 }],
  'claude-3-5-haiku': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.8, outputPerMillion: 4 }],

  // OpenAI models Codex can run, from developers.openai.com/api/docs/pricing (Standard tier,
  // short context), 2026-09-22, rechecked 2026-10-12. Cache reads are 0.1x input unless set.
  // GPT-5.6 and later charge 1.25x input for a cache write; earlier models bill cache writes as
  // plain input. Fast mode is 2x every rate unless fastMultiplier says otherwise.
  'gpt-6-astra': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 10, outputPerMillion: 50, cacheWriteMultiplier: 1.25, longContext: OPENAI_LONG_CONTEXT },
  ],
  'gpt-6.1-sol': [
    {
      effectiveFrom: '2000-01-01',
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadMultiplier: 0.05,
      cacheWriteMultiplier: 1.25,
      longContext: OPENAI_LONG_CONTEXT,
    },
  ],
  'gpt-6-sol': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 10, cacheWriteMultiplier: 1.25, longContext: OPENAI_LONG_CONTEXT },
  ],
  'gpt-6-luna': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 0.1, outputPerMillion: 0.5, cacheWriteMultiplier: 1.25, longContext: OPENAI_LONG_CONTEXT },
  ],
  // Promotional price, published as available at least through 2026-11-21.
  'gpt-5.6-sol': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 4, outputPerMillion: 20, cacheWriteMultiplier: 1.25, longContext: OPENAI_LONG_CONTEXT },
  ],
  'gpt-5.6-terra': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 12, cacheWriteMultiplier: 1.25, longContext: OPENAI_LONG_CONTEXT },
  ],
  'gpt-5.6-luna': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 0.2, outputPerMillion: 1.2, cacheWriteMultiplier: 1.25, longContext: OPENAI_LONG_CONTEXT },
  ],
  'gpt-5.5': [
    {
      effectiveFrom: '2000-01-01',
      inputPerMillion: 5,
      outputPerMillion: 30,
      cacheWriteMultiplier: 1,
      longContext: OPENAI_LONG_CONTEXT,
      // Its fast row is $12.50 / $75: 2.5x, not the usual 2x.
      fastMultiplier: 2.5,
    },
  ],
  'gpt-5.4': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 2.5, outputPerMillion: 15, cacheWriteMultiplier: 1, longContext: OPENAI_LONG_CONTEXT },
  ],
  'gpt-5.4-mini': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.75, outputPerMillion: 4.5, cacheWriteMultiplier: 1 }],
  'gpt-5.3-codex': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.75, outputPerMillion: 14, cacheWriteMultiplier: 1 }],
  'gpt-5.2': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.75, outputPerMillion: 14, cacheWriteMultiplier: 1 }],
  'gpt-5.1': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 10, cacheWriteMultiplier: 1 }],
  'gpt-5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 10, cacheWriteMultiplier: 1 }],
  // Its fast row is $0.45 / $3.60: 1.8x.
  'gpt-5-mini': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 0.25, outputPerMillion: 2, cacheWriteMultiplier: 1, fastMultiplier: 1.8 },
  ],

  // Cursor Composer 2.5, from cursor.com/docs/models (on-demand, USD per 1M), 2026-09-24. No cache-write
  // price is listed, so cache writes are billed as plain input, like the OpenAI models above. The Fast
  // variant is its own entry: its rates are not a flat multiple of Standard, so the generic fast tier
  // cannot express it. The Cursor adapter names it `composer-2.5-fast`.
  'composer-2.5': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadMultiplier: 0.4, cacheWriteMultiplier: 1 },
  ],
  'composer-2.5-fast': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 3, outputPerMillion: 15, cacheReadMultiplier: 0.5 / 3, cacheWriteMultiplier: 1 },
  ],
};

/** Anthropic prices a cache write at these multiples of the model's base input rate, by TTL. */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
/**
 * The standard cache-read multiple; a model entry's cacheReadMultiplier overrides it. Matches
 * CACHE_READ_WEIGHT in tokens.ts — the same ratio, arrived at independently.
 */
export const CACHE_READ_COST_MULTIPLIER = 0.1;
/** Fast mode (formerly Priority) doubles every applicable rate, unless a model's entry says otherwise. */
export const FAST_MODE_MULTIPLIER = 2;

/** The rate in effect for a model on a given calendar day — the latest entry not later than that day. */
export function findRate(model: string, date: string): ModelRate | null {
  const entries = RATES[modelLabel(model)];
  if (!entries) return null;
  let active: ModelRateEntry | null = null;
  for (const entry of entries) {
    if (entry.effectiveFrom <= date && (!active || entry.effectiveFrom > active.effectiveFrom)) active = entry;
  }
  if (!active) return null;
  return {
    inputPerMillion: active.inputPerMillion,
    outputPerMillion: active.outputPerMillion,
    cacheReadMultiplier: active.cacheReadMultiplier ?? CACHE_READ_COST_MULTIPLIER,
    cacheWriteMultiplier: active.cacheWriteMultiplier ?? null,
    longContext: active.longContext ?? null,
    fastMultiplier: active.fastMultiplier ?? (active.cacheWriteMultiplier === undefined ? null : FAST_MODE_MULTIPLIER),
  };
}

export interface CurrentRate extends ModelRate {
  model: string;
}

/** The rate each known model carries today (or as of a given date) — for display, not billing math. */
export function currentRates(asOfDate: string = new Date().toISOString().slice(0, 10)): CurrentRate[] {
  return Object.keys(RATES)
    .map((model) => {
      const rate = findRate(model, asOfDate);
      return rate ? { model, ...rate } : null;
    })
    .filter((rate): rate is CurrentRate => rate !== null);
}

export interface ModelCost {
  /** False means dollars is 0 because the rate or the cache split is unknown — not because nothing was spent. */
  priced: boolean;
  dollars: number;
}

const UNPRICED: ModelCost = { priced: false, dollars: 0 };

/**
 * Real dollar cost for one model's counts, at one pricing tier, on one day. Unpriced (no rate in
 * effect on that day, a tier with no published rate, or an Anthropic row whose cache split is
 * unknown) returns 0 with priced: false.
 */
export function costForSplitCounts(
  model: string,
  date: string,
  counts: SplitTokenCounts,
  tier: PricingTier = DEFAULT_PRICING_TIER,
): ModelCost {
  const rate = findRate(model, date);
  if (!rate) return UNPRICED;

  // A tier the model publishes no rate for stays unpriced rather than borrowing the standard one.
  const long = tier === 'long-context' || tier === 'fast-long-context';
  const fast = tier === 'fast' || tier === 'fast-long-context';
  if ((long && !rate.longContext) || (fast && rate.fastMultiplier === null)) return UNPRICED;
  const speed = fast ? (rate.fastMultiplier ?? 1) : 1;
  const inputRate = rate.inputPerMillion * (long ? (rate.longContext?.input ?? 1) : 1) * speed;
  const outputRate = rate.outputPerMillion * (long ? (rate.longContext?.output ?? 1) : 1) * speed;

  if (rate.cacheWriteMultiplier === null) {
    if (counts.cacheCreation5mTokens === null || counts.cacheCreation1hTokens === null) return UNPRICED;
    const dollars =
      (counts.inputTokens * inputRate) / 1e6 +
      (counts.outputTokens * outputRate) / 1e6 +
      (counts.cacheCreation5mTokens * inputRate * CACHE_WRITE_5M_MULTIPLIER) / 1e6 +
      (counts.cacheCreation1hTokens * inputRate * CACHE_WRITE_1H_MULTIPLIER) / 1e6 +
      (counts.cacheReadTokens * inputRate * rate.cacheReadMultiplier) / 1e6;
    return { priced: true, dollars };
  }

  const dollars =
    (counts.inputTokens * inputRate) / 1e6 +
    (counts.cacheCreationTokens * inputRate * rate.cacheWriteMultiplier) / 1e6 +
    (counts.cacheReadTokens * inputRate * rate.cacheReadMultiplier) / 1e6 +
    (counts.outputTokens * outputRate) / 1e6;
  return { priced: true, dollars };
}
