import { describe, expect, it } from 'vitest';
import { addDays, dateKey, isDateKey } from '../src/dates.js';

describe('dateKey', () => {
  it('formats an instant as YYYY-MM-DD', () => {
    expect(dateKey(new Date('2026-09-10T12:00:00Z'), 'UTC')).toBe('2026-09-10');
  });

  it('assigns the instant to the calendar day of the given time zone', () => {
    // 23:30 in Istanbul (UTC+3) is still the 10th there, already the 10th in UTC.
    const instant = new Date('2026-09-10T20:30:00Z');
    expect(dateKey(instant, 'Europe/Istanbul')).toBe('2026-09-10');
    expect(dateKey(instant, 'UTC')).toBe('2026-09-10');
  });

  it('can land on different days for different time zones', () => {
    // 02:00 on the 11th in Istanbul is still 23:00 on the 10th in UTC.
    const instant = new Date('2026-09-10T23:00:00Z');
    expect(dateKey(instant, 'Europe/Istanbul')).toBe('2026-09-11');
    expect(dateKey(instant, 'UTC')).toBe('2026-09-10');
  });
});

describe('addDays', () => {
  it('moves forward and backward', () => {
    const base = new Date('2026-09-10T00:00:00Z');
    expect(dateKey(addDays(base, 5), 'UTC')).toBe('2026-09-15');
    expect(dateKey(addDays(base, -11), 'UTC')).toBe('2026-08-30');
  });
});

describe('isDateKey', () => {
  it('accepts real calendar dates', () => {
    expect(isDateKey('2026-02-28')).toBe(true);
  });

  it('rejects malformed and impossible dates', () => {
    expect(isDateKey('2026-9-10')).toBe(false);
    expect(isDateKey('not-a-date')).toBe(false);
    expect(isDateKey('2026-02-30')).toBe(false);
    expect(isDateKey('2026-13-01')).toBe(false);
  });
});
