import { describe, expect, it } from 'vitest';
import { datesBetween, rangeWindow, shiftDate } from '../../src/story/range.js';

describe('shiftDate', () => {
  it('crosses month and year boundaries', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('datesBetween', () => {
  it('includes both ends', () => {
    expect(datesBetween('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });

  it('is empty when the start is after the end', () => {
    expect(datesBetween('2026-03-02', '2026-03-01')).toEqual([]);
  });
});

describe('rangeWindow', () => {
  it('ends today and spans the preset number of days', () => {
    expect(rangeWindow('30d', '2026-09-15', ['2026-09-10'])).toEqual({
      startDate: '2026-08-17',
      endDate: '2026-09-15',
    });
    const year = rangeWindow('1y', '2026-09-15', []);
    expect(datesBetween(year.startDate, year.endDate)).toHaveLength(365);
  });

  it('extends to tomorrow when a client ahead of UTC already has usage there', () => {
    expect(rangeWindow('30d', '2026-09-15', ['2026-09-16']).endDate).toBe('2026-09-16');
  });

  it('starts all time at the earliest day the person actually has', () => {
    expect(rangeWindow('all', '2026-09-15', ['2026-03-02', '2024-01-09', '2025-11-30'])).toEqual({
      startDate: '2024-01-09',
      endDate: '2026-09-15',
    });
  });

  it('collapses all time to a single day when there is nothing to show', () => {
    expect(rangeWindow('all', '2026-09-15', [])).toEqual({ startDate: '2026-09-15', endDate: '2026-09-15' });
  });
});

describe('today range', () => {
  it('is the single end day of the window, tomorrow when usage is already there', () => {
    expect(rangeWindow('today', '2026-09-15', [])).toEqual({ startDate: '2026-09-15', endDate: '2026-09-15' });
    expect(rangeWindow('today', '2026-09-15', ['2026-09-16'])).toEqual({
      startDate: '2026-09-16',
      endDate: '2026-09-16',
    });
  });
});
