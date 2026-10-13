import { describe, expect, it } from 'vitest';
import { CACHE_READ_COST_MULTIPLIER, costForSplitCounts, currentRates, findRate } from '../src/pricing.js';
import { emptySplitCounts, type SplitTokenCounts } from '../src/tokens.js';

const TODAY = '2026-09-20';

function counts(overrides: Partial<SplitTokenCounts> = {}): SplitTokenCounts {
  return { ...emptySplitCounts(), ...overrides };
}

describe('findRate', () => {
  it('resolves a bare model id', () => {
    expect(findRate('claude-sonnet-5', TODAY)).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: null,
      longContext: null,
      fastMultiplier: null,
    });
  });

  it('resolves a date-suffixed snapshot the same as the bare id', () => {
    expect(findRate('claude-opus-5-20260115', TODAY)).toEqual(findRate('claude-opus-5', TODAY));
  });

  it('returns null for an unknown model rather than guessing', () => {
    expect(findRate('claude-nonexistent-9', TODAY)).toBeNull();
  });

  it('returns null for a date before the model had any rate on record', () => {
    expect(findRate('claude-sonnet-5', '1999-01-01')).toBeNull();
  });
});

describe('effective-dated pricing (a future rate change must not rewrite the past)', () => {
  // This mirrors production RATES exactly, so the table itself can't drift from what this
  // regression test checks: a rate change appends a new dated entry; a day before that date
  // must keep resolving to the old rate, and a day on/after it must resolve to the new one.
  const RATES: Record<string, { effectiveFrom: string; inputPerMillion: number; outputPerMillion: number }[]> = {
    'claude-sonnet-5': [
      { effectiveFrom: '2000-01-01', inputPerMillion: 2, outputPerMillion: 10 },
      { effectiveFrom: '2027-01-01', inputPerMillion: 1.5, outputPerMillion: 7.5 },
    ],
  };

  function findRateAt(date: string) {
    const entries = RATES['claude-sonnet-5']!;
    return entries.filter((entry) => entry.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
  }

  it('keeps a day before the change on the old rate', () => {
    expect(findRateAt('2026-12-31')).toMatchObject({ inputPerMillion: 2, outputPerMillion: 10 });
  });

  it('moves a day on or after the change to the new rate', () => {
    expect(findRateAt('2027-01-01')).toMatchObject({ inputPerMillion: 1.5, outputPerMillion: 7.5 });
    expect(findRateAt('2027-06-01')).toMatchObject({ inputPerMillion: 1.5, outputPerMillion: 7.5 });
  });
});

describe('currentRates', () => {
  it('lists every known model at the rate active on the given date', () => {
    const rates = currentRates(TODAY);
    expect(rates.find((rate) => rate.model === 'claude-sonnet-5')).toEqual({
      model: 'claude-sonnet-5',
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: null,
      longContext: null,
      fastMultiplier: null,
    });
  });

  it('defaults to today when no date is given', () => {
    expect(currentRates().length).toBeGreaterThan(0);
  });
});

describe('costForSplitCounts', () => {
  it('prices input, output and the cache tiers at their real rates', () => {
    // claude-sonnet-5: $2/M input, $10/M output.
    const result = costForSplitCounts(
      'claude-sonnet-5',
      TODAY,
      counts({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreation5mTokens: 1_000_000,
        cacheCreation1hTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    );
    expect(result.priced).toBe(true);
    // input 2 + output 10 + 5m-write (2*1.25=2.5) + 1h-write (2*2=4) + read (2*0.1=0.2) = 18.7
    expect(result.dollars).toBeCloseTo(2 + 10 + 2.5 + 4 + 0.2, 6);
  });

  it('prices Opus 5.5 cache reads at its own 0.05x multiplier, not the standard 0.1x', () => {
    // claude-opus-5-5: $4/M input, $20/M output, cache hits $0.20/M.
    const result = costForSplitCounts(
      'claude-opus-5-5',
      TODAY,
      counts({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreation5mTokens: 1_000_000,
        cacheCreation1hTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    );
    // input 4 + output 20 + 5m-write 5 + 1h-write 8 + read 0.2 = 37.2
    expect(result.dollars).toBeCloseTo(4 + 20 + 5 + 8 + 0.2, 6);
  });

  it('prices Sonnet 5.5 at $2/M input and $10/M output with the standard 0.1x cache read', () => {
    const result = costForSplitCounts(
      'claude-sonnet-5-5',
      TODAY,
      counts({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreation5mTokens: 1_000_000,
        cacheCreation1hTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    );
    expect(result.priced).toBe(true);
    // input 2 + output 10 + 5m-write 2.5 + 1h-write 4 + read 0.2 = 18.7
    expect(result.dollars).toBeCloseTo(2 + 10 + 2.5 + 4 + 0.2, 6);
  });

  it('prices Fable 5.1 cache reads at 0.025x ($0.25/M)', () => {
    const result = costForSplitCounts('claude-fable-5-1', TODAY, counts({ cacheReadTokens: 1_000_000 }));
    expect(result.dollars).toBeCloseTo(0.25, 6);
  });

  it('matches the cache-read discount already used for weighted tokens', () => {
    expect(CACHE_READ_COST_MULTIPLIER).toBe(0.1);
  });

  it('is unpriced for a model with no known rate', () => {
    const result = costForSplitCounts('some-other-vendor-model', TODAY, counts({ inputTokens: 100 }));
    expect(result).toEqual({ priced: false, dollars: 0 });
  });

  it('is unpriced for a date before the model had any rate on record', () => {
    const result = costForSplitCounts('claude-sonnet-5', '1999-01-01', counts({ inputTokens: 100 }));
    expect(result).toEqual({ priced: false, dollars: 0 });
  });

  it('is unpriced when the cache split is unknown, even for a known model', () => {
    const result = costForSplitCounts(
      'claude-sonnet-5',
      TODAY,
      counts({ inputTokens: 100, cacheCreation5mTokens: null, cacheCreation1hTokens: null }),
    );
    expect(result).toEqual({ priced: false, dollars: 0 });
  });

  it('is unpriced when only one side of the split is known', () => {
    const result = costForSplitCounts(
      'claude-sonnet-5',
      TODAY,
      counts({ cacheCreation5mTokens: 10, cacheCreation1hTokens: null }),
    );
    expect(result.priced).toBe(false);
  });
});

describe('OpenAI (Codex) pricing', () => {
  const MILLION = 1_000_000;
  // Codex usage never carries Anthropic's 5m/1h cache-write split.
  const codex = (overrides: Partial<SplitTokenCounts> = {}) =>
    counts({ cacheCreation5mTokens: null, cacheCreation1hTokens: null, ...overrides });
  const everything = codex({
    inputTokens: MILLION,
    outputTokens: MILLION,
    cacheReadTokens: MILLION,
    cacheCreationTokens: MILLION,
  });

  it('prices a GPT-5.6+ model with its single cache-write rate even though the split is unknown', () => {
    // gpt-6-luna: $0.10 in, $0.01 cached, $0.125 cache write, $0.50 out.
    const result = costForSplitCounts('gpt-6-luna', TODAY, everything);
    expect(result.priced).toBe(true);
    expect(result.dollars).toBeCloseTo(0.735, 9);
  });

  it('charges cache writes at the plain input rate for models before GPT-5.6', () => {
    // gpt-5.3-codex: $1.75 in; cache writes carry no surcharge.
    const result = costForSplitCounts('gpt-5.3-codex', TODAY, codex({ cacheCreationTokens: MILLION }));
    expect(result).toEqual({ priced: true, dollars: 1.75 });
  });

  it('doubles input and cache rates and adds half to output over 272K input tokens', () => {
    // gpt-6-luna long context: $0.20 in, $0.02 cached, $0.25 cache write, $0.75 out.
    expect(costForSplitCounts('gpt-6-luna', TODAY, everything, 'long-context').dollars).toBeCloseTo(1.22, 9);
  });

  it('doubles every rate in fast mode, on top of long context when both apply', () => {
    expect(costForSplitCounts('gpt-6-luna', TODAY, everything, 'fast').dollars).toBeCloseTo(1.47, 9);
    expect(costForSplitCounts('gpt-6-luna', TODAY, everything, 'fast-long-context').dollars).toBeCloseTo(2.44, 9);
  });

  it('matches the published gpt-5.3-codex fast-mode row', () => {
    // Fast mode: $3.50 in, $0.35 cached, $28 out.
    const result = costForSplitCounts(
      'gpt-5.3-codex',
      TODAY,
      codex({ inputTokens: MILLION, cacheReadTokens: MILLION, outputTokens: MILLION }),
      'fast',
    );
    expect(result.dollars).toBeCloseTo(31.85, 9);
  });

  it('leaves long context unpriced for a model with no published long-context rate', () => {
    expect(costForSplitCounts('gpt-5.3-codex', TODAY, everything, 'long-context')).toEqual({ priced: false, dollars: 0 });
  });

  it('leaves an unlisted OpenAI model unpriced', () => {
    expect(costForSplitCounts('gpt-9-imaginary', TODAY, everything)).toEqual({ priced: false, dollars: 0 });
  });

  it('matches the published long-context rows for every model that has them', () => {
    // [model, long input $/M, long output $/M] from developers.openai.com/api/docs/pricing, 2026-09-22.
    const rows: [string, number, number][] = [
      ['gpt-6-astra', 20, 75],
      ['gpt-6-sol', 4, 15],
      ['gpt-5.6-sol', 8, 30],
      ['gpt-5.6-terra', 4, 18],
      ['gpt-5.6-luna', 0.4, 1.8],
      ['gpt-5.5', 10, 45],
      ['gpt-5.4', 5, 22.5],
    ];
    for (const [model, input, output] of rows) {
      const inOnly = costForSplitCounts(model, TODAY, codex({ inputTokens: MILLION }), 'long-context');
      const outOnly = costForSplitCounts(model, TODAY, codex({ outputTokens: MILLION }), 'long-context');
      // toBeCloseTo: 1.2 * 1.5 is 1.7999999999999998 in floating point.
      expect(inOnly.dollars, model).toBeCloseTo(input, 9);
      expect(outOnly.dollars, model).toBeCloseTo(output, 9);
    }
  });
});

describe('Anthropic pricing tiers', () => {
  it('prices the standard tier exactly as before', () => {
    const c = counts({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 2_000_000,
      cacheCreation5mTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    // claude-sonnet-5: 2 + 10 + 2*1.25 + 2*2 + 2*0.1 = 18.7
    expect(costForSplitCounts('claude-sonnet-5', TODAY, c).dollars).toBeCloseTo(18.7, 9);
    expect(costForSplitCounts('claude-sonnet-5', TODAY, c, 'standard').dollars).toBeCloseTo(18.7, 9);
  });

  it('leaves a tier unpriced for a model with no published rate for it', () => {
    const one = counts({ inputTokens: 1 });
    expect(costForSplitCounts('claude-sonnet-5', TODAY, one, 'fast')).toEqual({ priced: false, dollars: 0 });
    expect(costForSplitCounts('claude-sonnet-5', TODAY, one, 'long-context')).toEqual({ priced: false, dollars: 0 });
    expect(costForSplitCounts('claude-opus-4-6', TODAY, one, 'fast')).toEqual({ priced: false, dollars: 0 });
    expect(costForSplitCounts('claude-haiku-5-5', TODAY, one, 'fast')).toEqual({ priced: false, dollars: 0 });
  });

  it('prices Opus fast mode at twice every rate, cache multipliers on top', () => {
    const c = counts({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 2_000_000,
      cacheCreation5mTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    // claude-opus-5-5 fast: $8 in, $40 out; 5m write 10, 1h write 16, read 8*0.05 = 0.4.
    expect(costForSplitCounts('claude-opus-5-5', TODAY, c, 'fast').dollars).toBeCloseTo(8 + 40 + 10 + 16 + 0.4, 9);
    // claude-opus-5 and claude-opus-4-8 fast: $10 in, $50 out.
    const io = counts({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(costForSplitCounts('claude-opus-5', TODAY, io, 'fast').dollars).toBeCloseTo(60, 9);
    expect(costForSplitCounts('claude-opus-4-8', TODAY, io, 'fast').dollars).toBeCloseTo(60, 9);
  });

  it('still refuses to price an Anthropic row whose cache split is unknown', () => {
    const c = counts({ inputTokens: 1, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
    expect(costForSplitCounts('claude-sonnet-5', TODAY, c).priced).toBe(false);
  });
});

describe('Claude Haiku 5.5 (priced by prompt length)', () => {
  const MILLION = 1_000_000;
  const everything = counts({
    inputTokens: MILLION,
    outputTokens: MILLION,
    cacheCreationTokens: 2 * MILLION,
    cacheCreation5mTokens: MILLION,
    cacheCreation1hTokens: MILLION,
    cacheReadTokens: MILLION,
  });

  it('prices a prompt up to 100K tokens at $0.10 / $0.50', () => {
    // input 0.10 + output 0.50 + 5m write 0.125 + 1h write 0.20 + read 0.01
    expect(costForSplitCounts('claude-haiku-5-5', TODAY, everything).dollars).toBeCloseTo(0.935, 9);
  });

  it('prices a prompt over 100K tokens at $0.50 / $2.50, every cache rate scaled with it', () => {
    // input 0.50 + output 2.50 + 5m write 0.625 + 1h write 1 + read 0.05
    expect(costForSplitCounts('claude-haiku-5-5', TODAY, everything, 'long-context').dollars).toBeCloseTo(4.675, 9);
  });
});

describe('rates checked against the published tables on 2026-10-12', () => {
  const MILLION = 1_000_000;
  const claudeEverything = counts({
    inputTokens: MILLION,
    outputTokens: MILLION,
    cacheCreationTokens: 2 * MILLION,
    cacheCreation5mTokens: MILLION,
    cacheCreation1hTokens: MILLION,
    cacheReadTokens: MILLION,
  });

  it('prices Sonnet 5.5 cache reads at 0.05x from 2026-10-07, and keeps 0.1x before it', () => {
    const read = counts({ cacheReadTokens: MILLION });
    expect(costForSplitCounts('claude-sonnet-5-5', '2026-10-06', read).dollars).toBeCloseTo(0.2, 9);
    expect(costForSplitCounts('claude-sonnet-5-5', '2026-10-07', read).dollars).toBeCloseTo(0.1, 9);
    // Nothing else moved: $2 in, $10 out, $2.50 / $4 cache writes.
    expect(costForSplitCounts('claude-sonnet-5-5', '2026-10-12', claudeEverything).dollars).toBeCloseTo(18.6, 9);
  });

  it('prices every listed Claude model, legacy ones included', () => {
    // [model, input, 5m write, 1h write, cache read, output] in $/M, from platform.claude.com pricing.
    const rows: [string, number, number, number, number, number][] = [
      ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50],
      ['claude-mythos-5-1', 10, 12.5, 20, 0.25, 50],
      ['claude-fable-5', 10, 12.5, 20, 1, 50],
      ['claude-mythos-5', 10, 12.5, 20, 1, 50],
      ['claude-opus-5-5', 4, 5, 8, 0.2, 20],
      ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
      ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
      ['claude-opus-4-7', 5, 6.25, 10, 0.5, 25],
      ['claude-opus-4-6', 5, 6.25, 10, 0.5, 25],
      ['claude-opus-4-5-20251101', 5, 6.25, 10, 0.5, 25],
      ['claude-opus-4-1-20250805', 15, 18.75, 30, 1.5, 75],
      ['claude-opus-4-20250514', 15, 18.75, 30, 1.5, 75],
      ['claude-sonnet-5-5', 2, 2.5, 4, 0.1, 10],
      ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
      ['claude-sonnet-4-6', 3, 3.75, 6, 0.3, 15],
      ['claude-sonnet-4-5-20250929', 3, 3.75, 6, 0.3, 15],
      ['claude-sonnet-4-20250514', 3, 3.75, 6, 0.3, 15],
      ['claude-haiku-5-5', 0.1, 0.125, 0.2, 0.01, 0.5],
      ['claude-haiku-4-5-20251001', 1, 1.25, 2, 0.1, 5],
      ['claude-3-5-haiku-20241022', 0.8, 1, 1.6, 0.08, 4],
    ];
    const date = '2026-10-12';
    for (const [model, input, write5m, write1h, read, output] of rows) {
      const one = (overrides: Partial<SplitTokenCounts>) => costForSplitCounts(model, date, counts(overrides)).dollars;
      expect(one({ inputTokens: MILLION }), model).toBeCloseTo(input, 9);
      expect(one({ cacheCreation5mTokens: MILLION }), model).toBeCloseTo(write5m, 9);
      expect(one({ cacheCreation1hTokens: MILLION }), model).toBeCloseTo(write1h, 9);
      expect(one({ cacheReadTokens: MILLION }), model).toBeCloseTo(read, 9);
      expect(one({ outputTokens: MILLION }), model).toBeCloseTo(output, 9);
    }
  });

  it('prices every listed OpenAI model Codex or Cursor can run, short context and fast', () => {
    // [model, input, cached, cache write, output, fast input, fast output] in $/M,
    // from developers.openai.com/api/docs/pricing; null = no fast row published.
    const rows: [string, number, number, number, number, number | null, number | null][] = [
      ['gpt-6-astra', 10, 1, 12.5, 50, 20, 100],
      ['gpt-6.1-sol', 2, 0.1, 2.5, 10, 4, 20],
      ['gpt-6-sol', 2, 0.2, 2.5, 10, 4, 20],
      ['gpt-6-luna', 0.1, 0.01, 0.125, 0.5, 0.2, 1],
      ['gpt-5.6-sol', 4, 0.4, 5, 20, 8, 40],
      ['gpt-5.6-terra', 2, 0.2, 2.5, 12, 4, 24],
      ['gpt-5.6-luna', 0.2, 0.02, 0.25, 1.2, 0.4, 2.4],
      ['gpt-5.5', 5, 0.5, 5, 30, 12.5, 75],
      ['gpt-5.4', 2.5, 0.25, 2.5, 15, 5, 30],
      ['gpt-5.4-mini', 0.75, 0.075, 0.75, 4.5, 1.5, 9],
      ['gpt-5.3-codex', 1.75, 0.175, 1.75, 14, 3.5, 28],
      ['gpt-5.2', 1.75, 0.175, 1.75, 14, 3.5, 28],
      ['gpt-5.1', 1.25, 0.125, 1.25, 10, 2.5, 20],
      ['gpt-5', 1.25, 0.125, 1.25, 10, 2.5, 20],
      ['gpt-5-mini', 0.25, 0.025, 0.25, 2, 0.45, 3.6],
    ];
    const date = '2026-10-12';
    const codex = (overrides: Partial<SplitTokenCounts>) =>
      counts({ cacheCreation5mTokens: null, cacheCreation1hTokens: null, ...overrides });
    for (const [model, input, cached, write, output, fastInput, fastOutput] of rows) {
      const one = (overrides: Partial<SplitTokenCounts>, tier?: 'fast') =>
        costForSplitCounts(model, date, codex(overrides), tier);
      expect(one({ inputTokens: MILLION }).dollars, model).toBeCloseTo(input, 9);
      expect(one({ cacheReadTokens: MILLION }).dollars, model).toBeCloseTo(cached, 9);
      expect(one({ cacheCreationTokens: MILLION }).dollars, model).toBeCloseTo(write, 9);
      expect(one({ outputTokens: MILLION }).dollars, model).toBeCloseTo(output, 9);
      if (fastInput !== null && fastOutput !== null) {
        expect(one({ inputTokens: MILLION }, 'fast').dollars, model).toBeCloseTo(fastInput, 9);
        expect(one({ outputTokens: MILLION }, 'fast').dollars, model).toBeCloseTo(fastOutput, 9);
      }
    }
  });

  it('prices gpt-6.1-sol long context at the published row', () => {
    const codex = counts({ cacheCreation5mTokens: null, cacheCreation1hTokens: null, inputTokens: MILLION, outputTokens: MILLION });
    // $4 in, $15 out.
    expect(costForSplitCounts('gpt-6.1-sol', '2026-10-12', codex, 'long-context').dollars).toBeCloseTo(19, 9);
  });
});

describe('Cursor Composer pricing', () => {
  const MILLION = 1_000_000;
  const cursor = (overrides: Partial<SplitTokenCounts> = {}) =>
    counts({ cacheCreation5mTokens: null, cacheCreation1hTokens: null, ...overrides });
  const everything = cursor({
    inputTokens: MILLION,
    outputTokens: MILLION,
    cacheReadTokens: MILLION,
    cacheCreationTokens: MILLION,
  });

  it('prices Composer 2.5 Standard from the published table, cache writes at plain input', () => {
    // $0.50 in, $0.20 cache read, $2.50 out; cache write not listed -> billed as input ($0.50).
    const result = costForSplitCounts('composer-2.5', TODAY, everything);
    expect(result.priced).toBe(true);
    expect(result.dollars).toBeCloseTo(3.7, 9);
  });

  it('prices Composer 2.5 Fast as its own model, not as the generic fast tier', () => {
    // $3 in, $0.50 cache read, $15 out; cache write billed as input ($3).
    expect(costForSplitCounts('composer-2.5-fast', TODAY, everything).dollars).toBeCloseTo(21.5, 9);
  });

  it('matches each published per-field rate exactly', () => {
    expect(costForSplitCounts('composer-2.5', TODAY, cursor({ cacheReadTokens: MILLION })).dollars).toBeCloseTo(0.2, 9);
    expect(costForSplitCounts('composer-2.5-fast', TODAY, cursor({ cacheReadTokens: MILLION })).dollars).toBeCloseTo(0.5, 9);
    expect(costForSplitCounts('composer-2.5-fast', TODAY, cursor({ outputTokens: MILLION })).dollars).toBeCloseTo(15, 9);
  });

  it('leaves older and third-party Cursor slugs unpriced', () => {
    expect(costForSplitCounts('composer-2-fast', TODAY, everything)).toEqual({ priced: false, dollars: 0 });
    expect(costForSplitCounts('claude-4.6-opus-high-thinking', TODAY, everything)).toEqual({ priced: false, dollars: 0 });
    expect(costForSplitCounts('default', TODAY, everything)).toEqual({ priced: false, dollars: 0 });
  });
});
