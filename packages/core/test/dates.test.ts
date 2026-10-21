import { describe, expect, it } from 'vitest';
import { addDays, dateKey, hourKey, isDateKey } from '../src/dates.js';

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

describe('hourKey', () => {
  it('is the local hour in the given zone, the same rule dateKey uses', () => {
    const instant = new Date('2026-09-10T23:00:00Z');
    expect(hourKey(instant, 'UTC')).toBe(23);
    expect(hourKey(instant, 'Europe/Istanbul')).toBe(2);
    expect(dateKey(instant, 'Europe/Istanbul')).toBe('2026-09-11');
  });

  it('floors a half-hour zone and gives 0 (never 24) at local midnight', () => {
    expect(hourKey(new Date('2026-09-10T12:40:00Z'), 'Asia/Kolkata')).toBe(18);
    expect(hourKey(new Date('2026-09-10T21:00:00Z'), 'Europe/Istanbul')).toBe(0);
    expect(hourKey(new Date('2026-09-10T00:00:00Z'), 'UTC')).toBe(0);
  });

  it('follows daylight saving: spring has no hour 2, autumn has hour 1 twice', () => {
    const tz = 'America/New_York';
    // 2026-03-08: clocks jump from 02:00 to 03:00.
    const spring = ['2026-03-08T05:30:00Z', '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z'].map((t) => [dateKey(new Date(t), tz), hourKey(new Date(t), tz)]);
    expect(spring).toEqual([['2026-03-08', 0], ['2026-03-08', 1], ['2026-03-08', 3]]);
    // 2026-11-01: 01:30 happens twice (EDT, then EST).
    const autumn = ['2026-11-01T04:30:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z'].map((t) => [dateKey(new Date(t), tz), hourKey(new Date(t), tz)]);
    expect(autumn).toEqual([['2026-11-01', 0], ['2026-11-01', 1], ['2026-11-01', 1], ['2026-11-01', 2]]);
  });
});
