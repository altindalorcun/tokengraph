import { modelLabel } from './models.js';
import { DEFAULT_PRICING_TIER, LONG_CONTEXT_THRESHOLD_TOKENS, type PricingTier } from './pricing-tiers.js';
import type { SplitTokenCounts } from './tokens.js';

/** A long-context request's rates as multiples of the standard ones, for the whole request. */
export interface LongContextMultipliers {
  input: number;
  output: number;
  /**
   * A prompt (input, cache reads and cache writes together) over this many tokens is billed at the
   * long-context rates for the whole request. Defaults to LONG_CONTEXT_THRESHOLD_TOKENS (OpenAI's 272K).
   */
  thresholdTokens?: number;
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
  longContext: (LongContextMultipliers & { thresholdTokens: number }) | null;
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
   * null: the vendor publishes no fast row, so the fast tiers stay unpriced (no default 2x).
   */
  fastMultiplier?: number | null;
}

/** OpenAI bills a long-context request (see LONG_CONTEXT_THRESHOLD_TOKENS) at these multiples, for the whole request. */
export const LONG_CONTEXT_INPUT_MULTIPLIER = 2;
export const LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;
const OPENAI_LONG_CONTEXT: LongContextMultipliers = {
  input: LONG_CONTEXT_INPUT_MULTIPLIER,
  output: LONG_CONTEXT_OUTPUT_MULTIPLIER,
};
/** Gemini bills a prompt over 200K tokens at 2x input and cache, 1.5x output, for the whole request. */
const GEMINI_LONG_CONTEXT: LongContextMultipliers = { ...OPENAI_LONG_CONTEXT, thresholdTokens: 200_000 };
/** xAI bills a prompt of 200K or more tokens at 2x input, cache and output, for the whole request. */
const XAI_LONG_CONTEXT: LongContextMultipliers = { input: 2, output: 2, thresholdTokens: 200_000 };

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
  // A prompt over 100K tokens pays $0.50 / $2.50, every cache rate scaled with it.
  'claude-haiku-5-5': [
    {
      effectiveFrom: '2000-01-01',
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      longContext: { input: 5, output: 5, thresholdTokens: 100_000 },
    },
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

  // OpenAI models added 2026-10-21 from developers.openai.com/api/docs/pricing (Standard, short context)
  // and, for the codex models (not on the pricing page), the per-model pages /api/docs/models/<id>.
  // None of these publishes a fast row, so fastMultiplier is null (fast stays unpriced). The Pro models
  // (gpt-5.5-pro, gpt-5.4-pro, gpt-5.2-pro, gpt-5-pro, o3-pro, o1-pro) publish no cached-input price and
  // stay unpriced rather than assume cache reads are not discounted.
  'gpt-5.4-nano': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.2, outputPerMillion: 1.25, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gpt-5-nano': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.05, outputPerMillion: 0.4, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gpt-5.2-codex': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.75, outputPerMillion: 14, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gpt-5.1-codex': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 10, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gpt-5.1-codex-max': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 10, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gpt-5.1-codex-mini': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.25, outputPerMillion: 2, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gpt-5-codex': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 10, cacheWriteMultiplier: 1, fastMultiplier: null }],
  // Cached input is $0.375: 0.25x.
  'codex-mini-latest': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 1.5, outputPerMillion: 6, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, fastMultiplier: null },
  ],
  // Older families: cached input is 0.25x (4.1, o3, o4-mini) or 0.5x (4o, o1, o3-mini). A fast row is
  // published where fastMultiplier is a number (the Fast column over the standard price).
  'gpt-4.1': [{ effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 8, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, fastMultiplier: 1.75 }],
  'gpt-4.1-mini': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, fastMultiplier: 1.75 }],
  'gpt-4.1-nano': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, fastMultiplier: 2 }],
  'gpt-4o': [{ effectiveFrom: '2000-01-01', inputPerMillion: 2.5, outputPerMillion: 10, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1, fastMultiplier: 1.7 }],
  'gpt-4o-mini': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1, fastMultiplier: 5 / 3 }],
  o1: [{ effectiveFrom: '2000-01-01', inputPerMillion: 15, outputPerMillion: 60, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1, fastMultiplier: null }],
  o3: [{ effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 8, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, fastMultiplier: 1.75 }],
  'o3-mini': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.1, outputPerMillion: 4.4, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'o4-mini': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.1, outputPerMillion: 4.4, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, fastMultiplier: 20 / 11 }],

  // Google Gemini API, from ai.google.dev/gemini-api/docs/pricing (paid Standard tier), 2026-10-21. Implicit
  // caching has no cache-write price (cacheWriteMultiplier 1); thinking tokens are billed as output. Priority
  // is 1.8x but no Gemini source here records it, so fastMultiplier is null. A prompt over 200K tokens pays
  // 2x input and cache, 1.5x output. Preview ids are priced only where Google published a price for that id.
  'gemini-3.1-pro-preview': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 12, cacheWriteMultiplier: 1, longContext: GEMINI_LONG_CONTEXT, fastMultiplier: null },
  ],
  'gemini-3.1-pro-preview-customtools': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 12, cacheWriteMultiplier: 1, longContext: GEMINI_LONG_CONTEXT, fastMultiplier: null },
  ],
  'gemini-3-flash-preview': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.5, outputPerMillion: 3, cacheWriteMultiplier: 1, fastMultiplier: null }],
  // $0.75 / $3.75 through 2026-12-31, doubling on 2027-01-01 (the page states both).
  'gemini-3.8-flash': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheWriteMultiplier: 1, fastMultiplier: null },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.5, outputPerMillion: 7.5, cacheWriteMultiplier: 1, fastMultiplier: null },
  ],
  'gemini-3.6-flash': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheWriteMultiplier: 1, fastMultiplier: null },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.5, outputPerMillion: 7.5, cacheWriteMultiplier: 1, fastMultiplier: null },
  ],
  // Retired and off Google's page, so Cursor's published model table (cursor.com/docs/models-and-pricing,
  // 2026-10-21) is the source; Cursor bills vendor models at API list price. Gemini 3.5 Flash 1.5 / 0.15 / 9,
  // Gemini 3.7 Flash 0.75 / 0.075 / 3.75, Gemini 3 Flash 0.5 / 0.05 / 3.
  'gemini-3.5-flash': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.5, outputPerMillion: 9, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gemini-3.7-flash': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gemini-3-flash': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.5, outputPerMillion: 3, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gemini-3.5-flash-lite': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.3, outputPerMillion: 2.5, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gemini-3.1-flash-lite': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.25, outputPerMillion: 1.5, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gemini-2.5-pro': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 10, cacheWriteMultiplier: 1, longContext: GEMINI_LONG_CONTEXT, fastMultiplier: null },
  ],
  'gemini-2.5-flash': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.3, outputPerMillion: 2.5, cacheWriteMultiplier: 1, fastMultiplier: null }],
  'gemini-2.5-flash-lite': [{ effectiveFrom: '2000-01-01', inputPerMillion: 0.1, outputPerMillion: 0.4, cacheWriteMultiplier: 1, fastMultiplier: null }],
  // $2 / $0.10 cache / $10 through 2026-11-30, doubling from 2026-12-01; no long-context tier is listed.
  'gemini-4-argon': [
    { effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 10, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1, fastMultiplier: null },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4, outputPerMillion: 20, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1, fastMultiplier: null },
  ],

  // xAI, from docs.x.ai/developers/models and /models/grok-4.5, 2026-10-21. A prompt of 200K or more tokens
  // pays 2x input, cache and output for the whole request. No cache-write price; no fast row. Only concrete
  // ids are priced (not -latest aliases); retired grok-3, grok-4-fast and grok-code-fast-1 publish no price.
  'grok-4.7': [{ effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 6, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, longContext: XAI_LONG_CONTEXT, fastMultiplier: null }],
  'grok-4.6': [{ effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 6, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1, longContext: XAI_LONG_CONTEXT, fastMultiplier: null }],
  'grok-4.5': [{ effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 6, cacheReadMultiplier: 0.15, cacheWriteMultiplier: 1, longContext: XAI_LONG_CONTEXT, fastMultiplier: null }],
  'grok-4.3': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 2.5, cacheReadMultiplier: 0.16, cacheWriteMultiplier: 1, longContext: XAI_LONG_CONTEXT, fastMultiplier: null }],
  'grok-4.20-0309-reasoning': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 2.5, cacheReadMultiplier: 0.16, cacheWriteMultiplier: 1, longContext: XAI_LONG_CONTEXT, fastMultiplier: null }],
  'grok-4.20-0309-non-reasoning': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1.25, outputPerMillion: 2.5, cacheReadMultiplier: 0.16, cacheWriteMultiplier: 1, longContext: XAI_LONG_CONTEXT, fastMultiplier: null }],
  'grok-build-0.1': [{ effectiveFrom: '2000-01-01', inputPerMillion: 1, outputPerMillion: 2, cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1, longContext: XAI_LONG_CONTEXT, fastMultiplier: null }],

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
    longContext: active.longContext
      ? { ...active.longContext, thresholdTokens: active.longContext.thresholdTokens ?? LONG_CONTEXT_THRESHOLD_TOKENS }
      : null,
    fastMultiplier:
      active.fastMultiplier !== undefined
        ? active.fastMultiplier
        : active.cacheWriteMultiplier === undefined
          ? null
          : FAST_MODE_MULTIPLIER,
  };
}

/**
 * The prompt size over which a request is billed at the model's long-context rates, read from the
 * model's own rate entry: null for a model that bills its whole context window at one rate. An
 * `gpt-` id without long-context rates (or unknown) gets OpenAI's threshold, so its long requests keep their own (unpriced) tier.
 * A threshold does not change by date, so the newest entry that carries long-context rates decides.
 */
export function longContextThreshold(model: string): number | null {
  const entries = RATES[modelLabel(model)];
  const withLong = entries?.filter((entry) => entry.longContext).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (withLong?.longContext) return withLong.longContext.thresholdTokens ?? LONG_CONTEXT_THRESHOLD_TOKENS;
  return model.startsWith('gpt-') ? LONG_CONTEXT_THRESHOLD_TOKENS : null;
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
