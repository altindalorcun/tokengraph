import { describe, expect, it } from 'vitest';
import { costBreakdown, rowCost, type CostRow } from '../../src/story/cost.js';

function row(date: string, model: string, overrides: Partial<CostRow> = {}): CostRow {
  return {
    date,
    model,
    pricingTier: 'standard',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    ...overrides,
  };
}

const WINDOW = { startDate: '2026-09-10', endDate: '2026-09-16' };

describe('costBreakdown', () => {
  it('prices a known model from its real per-token rate', () => {
    // claude-sonnet-5: $2/M input, $10/M output.
    const { totalDollars, models, complete } = costBreakdown(
      [row('2026-09-11', 'claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })],
      WINDOW,
    );
    expect(complete).toBe(true);
    expect(totalDollars).toBeCloseTo(12, 6);
    expect(models[0]).toMatchObject({ label: 'claude-sonnet-5', dollars: 12, priced: true });
  });

  it('ignores rows outside the window', () => {
    const { totalDollars } = costBreakdown(
      [row('2026-01-01', 'claude-sonnet-5', { inputTokens: 1_000_000 })],
      WINDOW,
    );
    expect(totalDollars).toBe(0);
  });

  it('marks a model unpriced, and excludes it from the total, when its rate is unknown', () => {
    const { totalDollars, complete, models } = costBreakdown(
      [row('2026-09-11', 'some-other-vendor-model', { inputTokens: 1_000_000 })],
      WINDOW,
    );
    expect(complete).toBe(false);
    expect(totalDollars).toBe(0);
    expect(models[0]).toMatchObject({ priced: false, dollars: 0 });
  });

  it('marks a known model unpriced when its cache-write split is unknown', () => {
    const { complete, models } = costBreakdown(
      [row('2026-09-11', 'claude-sonnet-5', { cacheCreation5mTokens: null, cacheCreation1hTokens: null })],
      WINDOW,
    );
    expect(complete).toBe(false);
    expect(models[0]!.priced).toBe(false);
  });

  it('sums the known days rather than hiding everything when only some days in the window are priced', () => {
    // claude-sonnet-5: $10/M output. One day unpriced (predates cost tracking), one day known.
    const { models, complete } = costBreakdown(
      [
        row('2026-09-11', 'claude-sonnet-5', { outputTokens: 1_000_000, cacheCreation5mTokens: null, cacheCreation1hTokens: null }),
        row('2026-09-14', 'claude-sonnet-5', { outputTokens: 1_000_000 }),
      ],
      WINDOW,
    );
    // The model's overall cost isn't fully known...
    expect(complete).toBe(false);
    // ...but the row must still show the known half, not hide behind a blanket "unpriced".
    expect(models[0]).toMatchObject({ dollars: 10, complete: false, priced: true });
  });

  it('groups dated snapshots of the same model under one label, like the token breakdown does', () => {
    const { models } = costBreakdown(
      [
        row('2026-09-11', 'claude-sonnet-5-20260101', { outputTokens: 1_000_000 }),
        row('2026-09-12', 'claude-sonnet-5-20260201', { outputTokens: 1_000_000 }),
      ],
      WINDOW,
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ label: 'claude-sonnet-5', dollars: 20 });
    expect(models[0]!.ids).toEqual(['claude-sonnet-5-20260101', 'claude-sonnet-5-20260201']);
  });

  it('sorts models heaviest cost first', () => {
    const { models } = costBreakdown(
      [
        row('2026-09-11', 'claude-haiku-4-5', { outputTokens: 1_000_000 }),
        row('2026-09-11', 'claude-opus-5', { outputTokens: 1_000_000 }),
      ],
      WINDOW,
    );
    expect(models.map((model) => model.label)).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
  });
});

describe('costBreakdown pricedSinceDate', () => {
  it('is the earliest date in the window with a known cache split', () => {
    const { pricedSinceDate } = costBreakdown(
      [
        row('2026-09-10', 'claude-sonnet-5', { cacheCreation5mTokens: null, cacheCreation1hTokens: null }),
        row('2026-09-14', 'claude-sonnet-5'),
        row('2026-09-12', 'claude-opus-5'),
      ],
      WINDOW,
    );
    expect(pricedSinceDate).toBe('2026-09-12');
  });

  it('is null when nothing in the window is priced yet', () => {
    const { pricedSinceDate } = costBreakdown(
      [row('2026-09-11', 'claude-sonnet-5', { cacheCreation5mTokens: null, cacheCreation1hTokens: null })],
      WINDOW,
    );
    expect(pricedSinceDate).toBeNull();
  });

  it('ignores a row outside the window even if it has a known split', () => {
    const { pricedSinceDate } = costBreakdown([row('2026-01-01', 'claude-sonnet-5')], WINDOW);
    expect(pricedSinceDate).toBeNull();
  });
});

describe('Codex (OpenAI) cost rows', () => {
  const codexRow = (overrides: Partial<CostRow> = {}) =>
    row('2026-09-12', 'gpt-6-luna', { cacheCreation5mTokens: null, cacheCreation1hTokens: null, ...overrides });

  it('prices a Codex row even though it has no cache-write split', () => {
    // gpt-6-luna: $0.10/M in, $0.125/M cache write, $0.50/M out.
    const { totalDollars, complete, models } = costBreakdown(
      [codexRow({ inputTokens: 1_000_000, cacheCreationTokens: 1_000_000, outputTokens: 1_000_000 })],
      WINDOW,
    );
    expect(complete).toBe(true);
    expect(totalDollars).toBeCloseTo(0.725, 9);
    expect(models[0]!.tokens.cacheCreationTokens).toBe(1_000_000);
  });

  it('prices each tier at its own rate and shows one model row', () => {
    const { totalDollars, models } = costBreakdown(
      [
        codexRow({ inputTokens: 1_000_000 }),
        codexRow({ inputTokens: 1_000_000, pricingTier: 'long-context' }),
      ],
      WINDOW,
    );
    expect(totalDollars).toBeCloseTo(0.3, 9);
    expect(models).toHaveLength(1);
    expect(models[0]!.tokens.inputTokens).toBe(2_000_000);
  });

  it('starts cost tracking at the first priced Codex day', () => {
    const { pricedSinceDate } = costBreakdown([codexRow({ inputTokens: 1 })], WINDOW);
    expect(pricedSinceDate).toBe('2026-09-12');
  });

  it('prices a single row at its own tier too', () => {
    const cost = rowCost(codexRow({ outputTokens: 1_000_000, pricingTier: 'fast' }));
    expect(cost.dollars).toBeCloseTo(1, 9);
    expect(cost.priced).toBe(true);
  });
});
