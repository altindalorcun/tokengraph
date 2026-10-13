import { describe, expect, it } from 'vitest';
import { graphEndDate, toGraphDaysByFamily, usageToModelRows, type ModelDayRow } from '../src/graph-days.js';

function row(date: string, model: string, counts: Partial<ModelDayRow> = {}): ModelDayRow {
  return { date, model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, ...counts };
}

describe('toGraphDaysByFamily', () => {
  it('shades a day by the model family that burned the most of it, summing a family’s models', () => {
    const [day] = toGraphDaysByFamily([
      row('2026-09-01', 'claude-opus-5-5', { outputTokens: 300 }),
      row('2026-09-01', 'claude-sonnet-5', { outputTokens: 300 }),
      row('2026-09-01', 'gpt-5.5', { outputTokens: 500 }),
    ]);
    expect(day!.topFamily).toBe('claude');
    expect(day!.weighted).toBe(1100);
  });

  it('puts models nobody recognises in other, never in Claude', () => {
    const [day] = toGraphDaysByFamily([row('2026-09-01', 'some-custom-model', { outputTokens: 10 })]);
    expect(day!.topFamily).toBe('other');
  });

  it('breaks an exact tie by family order', () => {
    const [day] = toGraphDaysByFamily([
      row('2026-09-01', 'qwen3-coder', { outputTokens: 100 }),
      row('2026-09-01', 'gemini-3-pro', { outputTokens: 100 }),
    ]);
    expect(day!.topFamily).toBe('gemini');
  });

  it('weighs the day from its summed raw counts', () => {
    const [day] = toGraphDaysByFamily([
      row('2026-09-01', 'claude-opus-5-5', { cacheReadTokens: 5 }),
      row('2026-09-01', 'gpt-5.5', { cacheReadTokens: 5 }),
    ]);
    expect(day!.weighted).toBe(1);
  });

  it('still names a top family when rounding would zero every family', () => {
    const [day] = toGraphDaysByFamily([
      row('2026-09-01', 'claude-opus-5-5', { cacheReadTokens: 4 }),
      row('2026-09-01', 'gpt-5.5', { cacheReadTokens: 3 }),
    ]);
    expect(day!.weighted).toBeGreaterThan(0);
    expect(day!.topFamily).toBe('claude');
  });

  it('sorts days by date and leaves a day with no usage without a family', () => {
    const days = toGraphDaysByFamily([row('2026-09-02', 'gpt-5.5', { outputTokens: 1 }), row('2026-09-01', 'gpt-5.5')]);
    expect(days.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02']);
    expect(days[0]!.topFamily).toBeNull();
  });

  it('sums rows of the same day and model from different machines', () => {
    const counts = { inputTokens: 100, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    const days = toGraphDaysByFamily([
      { date: '2026-10-01', model: 'claude-opus-5-5', ...counts },
      { date: '2026-10-01', model: 'claude-opus-5-5', ...counts },
    ]);
    expect(days).toEqual([{ date: '2026-10-01', weighted: 200, topFamily: 'claude' }]);
  });
});

describe('usageToModelRows', () => {
  it('folds tiers and the cache split away', () => {
    const counts = { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, cacheCreation5mTokens: 3, cacheCreation1hTokens: 0 };
    expect(usageToModelRows([{ date: '2026-10-01', model: 'm', pricingTier: 'fast', counts }])).toEqual([
      { date: '2026-10-01', model: 'm', inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
    ]);
  });
});

describe('graphEndDate', () => {
  it('extends past today for usage ahead of UTC', () => {
    expect(graphEndDate('2026-10-13', ['2026-10-12', '2026-10-14'])).toBe('2026-10-14');
    expect(graphEndDate('2026-10-13', [])).toBe('2026-10-13');
  });
});
