import { describe, expect, it } from 'vitest';
import { buildGraphGrid, type GraphDay } from '../src/graph.js';
import { computeGraphStats } from '../src/graph-stats.js';
import type { ModelFamily } from '../src/model-makers.js';

const END = '2026-09-10';

function day(offsetFromEnd: number, weighted: number, topFamily: ModelFamily | null = null): GraphDay {
  const date = new Date(new Date(`${END}T00:00:00Z`).getTime() - offsetFromEnd * 86_400_000).toISOString().slice(0, 10);
  return { date, weighted, topFamily };
}

const stats = (days: GraphDay[]) => computeGraphStats(buildGraphGrid(days, END));

describe('computeGraphStats', () => {
  it('counts the run that ends today', () => {
    const s = stats([day(0, 5), day(1, 5), day(2, 5), day(4, 5)]);
    expect(s.currentStreak).toBe(3);
    expect(s.longestStreak).toBe(3);
  });

  it('does not break the streak when today has no tokens yet: yesterday counts', () => {
    expect(stats([day(1, 5), day(2, 5), day(3, 5)]).currentStreak).toBe(3);
  });

  it('ends the streak when yesterday was missed as well', () => {
    expect(stats([day(2, 5), day(3, 5)]).currentStreak).toBe(0);
    expect(stats([day(0, 5), day(2, 5), day(3, 5)]).currentStreak).toBe(1);
  });

  it('finds the longest streak anywhere in the window, not only the current one', () => {
    const s = stats([day(0, 5), day(10, 5), day(11, 5), day(12, 5), day(13, 5), day(14, 5), day(30, 5), day(31, 5)]);
    expect(s.longestStreak).toBe(5);
    expect(s.currentStreak).toBe(1);
    expect(s.activeDays).toBe(8);
  });

  it('names the busiest day and takes the earliest on a tie', () => {
    const s = stats([day(0, 10), day(5, 99), day(9, 99), day(12, 3)]);
    expect(s.bestDay).toEqual({ date: day(9, 0).date, weighted: 99 });
  });

  it('ranks families by the days they led, not by tokens', () => {
    const s = stats([
      day(0, 1, 'gpt'),
      day(1, 1, 'gpt'),
      day(2, 1, 'gpt'),
      day(3, 1_000_000, 'claude'),
      day(4, 1_000_000, 'claude'),
    ]);
    expect(s.topFamily).toEqual({ family: 'gpt', days: 3 });
  });

  it('breaks a tie by family order and ignores days without tokens', () => {
    const s = stats([day(0, 5, 'gemini'), day(1, 5, 'claude'), day(2, 0, 'gpt'), day(3, 0, 'gpt'), day(4, 0, 'gpt')]);
    expect(s.topFamily).toEqual({ family: 'claude', days: 1 });
  });

  it('has no top family when days carry none (single-colour data)', () => {
    expect(stats([day(0, 5)]).topFamily).toBeNull();
  });

  it('is all zeros and nulls for an empty window, never NaN', () => {
    const s = stats([]);
    expect(s).toMatchObject({ activeDays: 0, total: 0, currentStreak: 0, longestStreak: 0, bestDay: null, topFamily: null });
    expect(s.windowDays).toBe(52 * 7 - 2);
    expect(s.firstDate).toBe('2025-09-14');
    expect(s.lastDate).toBe(END);
  });

  it('counts only drawn days: usage outside the 52 weeks is ignored', () => {
    const s = stats([day(0, 5), { date: '2020-01-01', weighted: 1_000_000, topFamily: 'glm' }]);
    expect(s.activeDays).toBe(1);
    expect(s.bestDay!.weighted).toBe(5);
    expect(s.topFamily).toBeNull();
  });
});
