import { describe, expect, it } from 'vitest';
import { limitLevel, limitViews, limitWindowLabel, type LimitReading } from '../src/limits.js';

const NOW = new Date('2026-11-19T12:00:00Z');

function reading(over: Partial<LimitReading> = {}): LimitReading {
  return {
    source: 'claude-code',
    limitId: null,
    plan: null,
    origin: 'statusline',
    readAt: '2026-11-19T11:57:00Z',
    credits: null,
    windows: [{ id: 'five_hour', minutes: 300, usedPercent: 58, resetsAt: '2026-11-19T13:00:00Z' }],
    ...over,
  };
}

describe('limitWindowLabel', () => {
  it('names the known windows', () => {
    expect(limitWindowLabel(300, 'x')).toBe('5h');
    expect(limitWindowLabel(10080, 'x')).toBe('7d');
    expect(limitWindowLabel(43200, 'x')).toBe('30d');
  });
  it('falls back to days, hours, minutes, then the id', () => {
    expect(limitWindowLabel(2880, 'x')).toBe('2d');
    expect(limitWindowLabel(120, 'x')).toBe('2h');
    expect(limitWindowLabel(45, 'x')).toBe('45m');
    expect(limitWindowLabel(null, 'seven_day_opus')).toBe('seven_day_opus');
  });
});

describe('limitLevel', () => {
  it('is good below 70, warn from 70, bad from 90', () => {
    expect(limitLevel(69.9)).toBe('good');
    expect(limitLevel(70)).toBe('warn');
    expect(limitLevel(89.9)).toBe('warn');
    expect(limitLevel(90)).toBe('bad');
    expect(limitLevel(100)).toBe('bad');
  });
});

describe('limitViews', () => {
  it('shows an open window with its level, reset time and age', () => {
    const [view] = limitViews([reading()], NOW);
    expect(view!.ageMs).toBe(180_000);
    expect(view!.windows).toEqual([
      { id: 'five_hour', label: '5h', minutes: 300, usedPercent: 58, resetsAt: '2026-11-19T13:00:00Z', reset: false, level: 'good', resetsInMs: 3_600_000 },
    ]);
  });

  it('never shows a percentage for a window that has reset', () => {
    const [view] = limitViews([reading({ windows: [{ id: 'five_hour', minutes: 300, usedPercent: 97, resetsAt: '2026-11-19T11:59:00Z' }] })], NOW);
    expect(view!.windows[0]).toMatchObject({ usedPercent: null, reset: true, level: null, resetsInMs: 0 });
  });

  it('clamps the age of a reading from the future at zero', () => {
    const [view] = limitViews([reading({ readAt: '2026-11-19T12:01:00Z' })], NOW);
    expect(view!.ageMs).toBe(0);
  });

  it('orders windows shortest first, unknown length last', () => {
    const windows = [10080, 300, null].map((minutes, i) => ({ id: `w${i}`, minutes, usedPercent: 1, resetsAt: '2026-11-20T00:00:00Z' }));
    const [view] = limitViews([reading({ windows })], NOW);
    expect(view!.windows.map((w) => w.minutes)).toEqual([300, 10080, null]);
  });

  it('puts Claude Code before Codex, then orders by limit id', () => {
    const views = limitViews(
      [
        reading({ source: 'codex-cli', limitId: 'codex_other' }),
        reading({ source: 'codex-cli', limitId: 'codex' }),
        reading({ source: 'claude-code' }),
      ],
      NOW,
    );
    expect(views.map((v) => `${v.source}:${v.limitId}`)).toEqual(['claude-code:null', 'codex-cli:codex', 'codex-cli:codex_other']);
  });

  it('keeps credits only when there are some or they are unlimited', () => {
    const none = { hasCredits: false, unlimited: false, balance: null };
    const some = { hasCredits: true, unlimited: false, balance: '12.50' };
    expect(limitViews([reading({ credits: none })], NOW)[0]!.credits).toBeNull();
    expect(limitViews([reading({ credits: some })], NOW)[0]!.credits).toEqual(some);
  });
});
