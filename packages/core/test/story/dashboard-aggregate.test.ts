import { describe, expect, it } from 'vitest';
import { emptyCounts } from '../../src/index.js';
import {
  cacheHitRate,
  formatShare,
  modelBreakdown,
  modelSegments,
  sumCounts,
  tokenTypeSegments,
  type ModelDayTotals,
} from '../../src/story/aggregate.js';

function row(date: string, model: string, input: number, output = 0, cacheWrite = 0, cacheRead = 0): ModelDayTotals {
  return {
    date,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
  };
}

const WINDOW = { startDate: '2026-09-10', endDate: '2026-09-16' };

describe('modelBreakdown', () => {
  const rows = [
    row('2026-09-11', 'claude-sonnet-4-5-20250929', 100),
    row('2026-09-12', 'claude-sonnet-4-5-20251101', 50),
    row('2026-09-12', 'claude-sonnet-5', 250),
    row('2026-09-12', 'claude-sonnet-5-5', 300),
    row('2026-09-12', 'claude-opus-5', 600),
    row('2026-09-09', 'gpt-5', 1000),
  ];

  it('lists every model on its own, heaviest first, ignoring days outside the window', () => {
    const models = modelBreakdown(rows, WINDOW);
    expect(models.map((model) => [model.label, model.name, model.weighted])).toEqual([
      ['claude-opus-5', 'Claude Opus 5', 600],
      ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 300],
      ['claude-sonnet-5', 'Claude Sonnet 5', 250],
      ['claude-sonnet-4-5', 'Claude Sonnet 4.5', 150],
    ]);
  });

  it('merges only ids that are the same model', () => {
    const sonnet45 = modelBreakdown(rows, WINDOW).find((model) => model.label === 'claude-sonnet-4-5')!;
    expect(sonnet45.ids).toEqual(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20251101']);
    expect(sonnet45.maker).toBe('anthropic');
  });

  it('measures every share against the whole window', () => {
    const models = modelBreakdown(rows, WINDOW);
    expect(models.map((model) => model.share)).toEqual([600 / 1300, 300 / 1300, 250 / 1300, 150 / 1300]);
  });

  it('sorts equal weights by name', () => {
    const models = modelBreakdown([row('2026-09-11', 'b-model', 10), row('2026-09-11', 'a-model', 10)], WINDOW);
    expect(models.map((model) => model.label)).toEqual(['a-model', 'b-model']);
  });

  it('colours by family, deeper for the heavier model of a family', () => {
    const rows = [row('2026-09-11', 'claude-opus-5', 300), row('2026-09-11', 'gpt-5', 200), row('2026-09-11', 'claude-sonnet-5', 100)];
    const colors = modelBreakdown(rows, WINDOW).map((model) => model.color);
    expect(colors).toEqual(['var(--graph-claude-5)', 'var(--graph-gpt-5)', 'var(--graph-claude-3)']);
  });

  it('returns zero shares rather than NaN when nothing carries weight', () => {
    const [model] = modelBreakdown([row('2026-09-11', 'claude-opus-5', 0, 0, 0, 1)], WINDOW);
    expect(model!.share).toBe(0);
  });
});

describe('modelSegments', () => {
  it('gives one segment per model in the same order, named and coloured like the rows', () => {
    const models = modelBreakdown([row('2026-09-11', 'claude-sonnet-5-5', 100), row('2026-09-11', 'claude-sonnet-5', 300)], WINDOW);
    expect(modelSegments(models)).toEqual([
      { label: 'Claude Sonnet 5', color: 'var(--graph-claude-5)', value: 300, share: 0.75 },
      { label: 'Claude Sonnet 5.5', color: 'var(--graph-claude-3)', value: 100, share: 0.25 },
    ]);
  });
});

describe('token types', () => {
  it('splits raw counts, leaving cache reads unweighted', () => {
    const segments = tokenTypeSegments({ inputTokens: 10, outputTokens: 30, cacheCreationTokens: 10, cacheReadTokens: 50 });
    expect(segments.map((segment) => [segment.label, segment.share])).toEqual([
      ['Input', 0.1],
      ['Output', 0.3],
      ['Cache write', 0.1],
      ['Cache read', 0.5],
    ]);
  });

  it('reports zero shares when there is no usage', () => {
    expect(tokenTypeSegments(emptyCounts()).every((segment) => segment.share === 0)).toBe(true);
  });

  it('sums counts across families', () => {
    const counts = { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 };
    expect(sumCounts([{ counts }, { counts }])).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 6,
      cacheReadTokens: 8,
    });
  });

  it('computes the cache hit rate over prompt tokens only', () => {
    expect(cacheHitRate({ inputTokens: 10, outputTokens: 999, cacheCreationTokens: 10, cacheReadTokens: 80 })).toBe(0.8);
    expect(cacheHitRate(emptyCounts())).toBeNull();
  });
});

describe('formatShare', () => {
  it('shows one decimal and never rounds a real share down to zero', () => {
    expect(formatShare(0.256)).toBe('25.6%');
    expect(formatShare(1)).toBe('100.0%');
    expect(formatShare(0)).toBe('0.0%');
    expect(formatShare(0.0004)).toBe('<0.1%');
  });
});
