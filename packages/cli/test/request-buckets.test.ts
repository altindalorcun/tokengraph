import { dateKey, hourKey, type SplitTokenCounts } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { RequestBuckets, tierForModel } from '../src/adapters/request-buckets.js';

function counts(overrides: Partial<SplitTokenCounts> = {}): SplitTokenCounts {
  return {
    inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0,
    cacheCreation5mTokens: null, cacheCreation1hTokens: null, ...overrides,
  };
}

describe('RequestBuckets', () => {
  it('merges copies of one request by per-field max, not sum', () => {
    const buckets = new RequestBuckets();
    buckets.add('r1', { date: '2026-09-27', model: 'm', pricingTier: 'standard', counts: counts({ outputTokens: 3 }) });
    buckets.add('r1', { date: '2026-09-27', model: 'm', pricingTier: 'standard', counts: counts({ outputTokens: 7 }) });
    expect(buckets.size).toBe(1);
    expect(buckets.toUsage()).toEqual([
      { date: '2026-09-27', model: 'm', pricingTier: 'standard', counts: counts({ outputTokens: 7 }) },
    ]);
  });

  it('keeps the first copy date and model, sums distinct requests, and keeps the null split', () => {
    const buckets = new RequestBuckets();
    buckets.add('a', { date: '2026-09-27', model: 'm', pricingTier: 'standard', counts: counts() });
    buckets.add('b', { date: '2026-09-27', model: 'm', pricingTier: 'standard', counts: counts() });
    buckets.add('c', { date: '2026-09-26', model: 'm', pricingTier: 'standard', counts: counts() });
    const usage = buckets.toUsage();
    expect(usage.map((u) => [u.date, u.counts.inputTokens])).toEqual([['2026-09-26', 10], ['2026-09-27', 20]]);
    expect(usage[1]?.counts.cacheCreation5mTokens).toBeNull();
  });
});

describe('tierForModel', () => {
  it('applies the OpenAI 272K long-context rule only to gpt models', () => {
    const long = counts({ inputTokens: 200_000, cacheReadTokens: 72_001 });
    expect(tierForModel('gpt-5.4', long)).toBe('long-context');
    expect(tierForModel('gpt-5.4', counts({ inputTokens: 272_000 }))).toBe('standard');
    expect(tierForModel('claude-sonnet-4-5', long)).toBe('standard');
    expect(tierForModel('gemini-3-flash-preview', long)).toBe('standard');
  });

  it('reads each model own threshold: 200K for Gemini and xAI, 272K for OpenAI, 100K for Haiku 5.5', () => {
    const over200 = counts({ inputTokens: 100_000, cacheReadTokens: 100_001 });
    const at200 = counts({ inputTokens: 100_000, cacheReadTokens: 100_000 });
    expect(tierForModel('gemini-2.5-pro', over200)).toBe('long-context');
    expect(tierForModel('gemini-3.1-pro-preview', at200)).toBe('standard');
    expect(tierForModel('grok-4.5', over200)).toBe('long-context');
    expect(tierForModel('grok-4.5', at200)).toBe('standard');
    expect(tierForModel('gpt-5.4', over200)).toBe('standard');
    expect(tierForModel('gemini-2.5-flash', over200)).toBe('standard');
    expect(tierForModel('gemini-2.5-pro', over200, true)).toBe('fast-long-context');
  });
});

describe('tierForModel for Claude models', () => {
  it('moves a Haiku 5.5 request over 100K prompt tokens, cache included, to long context', () => {
    expect(tierForModel('claude-haiku-5-5', counts({ inputTokens: 100_000 }))).toBe('standard');
    expect(tierForModel('claude-haiku-5-5', counts({ inputTokens: 1, cacheReadTokens: 90_000, cacheCreationTokens: 10_000 }))).toBe(
      'long-context',
    );
  });

  it('keeps other Claude models standard however long the prompt', () => {
    expect(tierForModel('claude-opus-5-5', counts({ inputTokens: 900_000 }))).toBe('standard');
  });

  it('records fast mode when the source reports it', () => {
    expect(tierForModel('claude-opus-5-5', counts(), true)).toBe('fast');
    expect(tierForModel('claude-haiku-5-5', counts({ inputTokens: 200_000 }), true)).toBe('fast-long-context');
  });
});

describe('RequestBuckets hours', () => {
  it('sums weighted tokens per date and hour, keeping the first copy hour and merging copies by max', () => {
    const buckets = new RequestBuckets();
    // weighted = 10 + 5 = 15 per request.
    buckets.add('a', { date: '2026-09-27', hour: 22, model: 'm', pricingTier: 'standard', counts: counts() });
    buckets.add('a', { date: '2026-09-27', hour: 23, model: 'm', pricingTier: 'standard', counts: counts({ outputTokens: 7 }) });
    buckets.add('b', { date: '2026-09-27', hour: 22, model: 'm', pricingTier: 'standard', counts: counts() });
    buckets.add('c', { date: '2026-09-28', hour: 0, model: 'm', pricingTier: 'standard', counts: counts() });
    expect(buckets.toHours()).toEqual([
      { date: '2026-09-27', hour: 22, weighted: 32 },
      { date: '2026-09-28', hour: 0, weighted: 15 },
    ]);
  });

  it('keeps the two instants of the repeated autumn hour in one bucket (a DST day, as every adapter keys it)', () => {
    const tz = 'America/New_York';
    const buckets = new RequestBuckets();
    for (const [i, at] of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-03-08T07:30:00Z'].entries()) {
      const instant = new Date(at);
      buckets.add(`r${i}`, { date: dateKey(instant, tz), hour: hourKey(instant, tz), model: 'm', pricingTier: 'standard', counts: counts() });
    }
    expect(buckets.toHours()).toEqual([
      { date: '2026-03-08', hour: 3, weighted: 15 },
      { date: '2026-11-01', hour: 1, weighted: 30 },
    ]);
  });
});
