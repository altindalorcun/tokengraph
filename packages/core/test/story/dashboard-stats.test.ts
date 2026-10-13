import { describe, expect, it } from 'vitest';
import { summarizeStats, type DailyWeight } from '../../src/story/stats.js';
import { shiftDate } from '../../src/story/range.js';

const END = '2026-09-15';

/** Day 0 is the end date, day 1 the day before, and so on. */
function days(weights: Record<number, number>): DailyWeight[] {
  return Object.entries(weights).map(([offset, weighted]) => ({
    date: shiftDate(END, -Number(offset)),
    weighted,
  }));
}

describe('summarizeStats', () => {
  it('reads today off the last day of the window', () => {
    expect(summarizeStats(days({ 0: 184_000, 1: 9 }), END).today).toBe(184_000);
  });

  it('is all zeros for an account with nothing in it', () => {
    expect(summarizeStats([], END)).toEqual({ today: 0, week: 0, weekDelta: null, streak: 0 });
  });

  it('sums the last seven days into the week', () => {
    expect(summarizeStats(days({ 0: 1, 3: 10, 6: 100, 7: 1000 }), END).week).toBe(111);
  });

  it('compares the week against the seven days before it', () => {
    expect(summarizeStats(days({ 0: 118, 7: 100 }), END).weekDelta).toBeCloseTo(0.18);
    expect(summarizeStats(days({ 0: 50, 7: 100 }), END).weekDelta).toBeCloseTo(-0.5);
  });

  it('has nothing to compare against in a first week', () => {
    expect(summarizeStats(days({ 0: 500 }), END).weekDelta).toBe(null);
  });

  it('counts consecutive active days back from today', () => {
    expect(summarizeStats(days({ 0: 1, 1: 1, 2: 1, 4: 1 }), END).streak).toBe(3);
  });

  it('does not break the streak on a today that has not started', () => {
    expect(summarizeStats(days({ 1: 1, 2: 1, 3: 1 }), END).streak).toBe(3);
  });

  it('does break it once a whole day has gone by', () => {
    expect(summarizeStats(days({ 2: 1, 3: 1, 4: 1 }), END).streak).toBe(0);
  });
});
