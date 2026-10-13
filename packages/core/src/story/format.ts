import { formatDollars, formatTokens } from '../graph.js';
import { cacheHitRate } from './aggregate.js';
import type { StoryData } from './data.js';

/** Wording and number formats shared by the cards. Locale-independent, like the embed. */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parts(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay() };
}

const short = (month: number) => MONTHS[month]!.slice(0, 3);

/** "Saturday, October 11, 2026" for a day; "Oct 5 – 11, 2026" or "Sep 12 – Oct 11, 2026" for a span. */
export function periodDateLabel(startDate: string, endDate: string): string {
  const s = parts(startDate);
  const e = parts(endDate);
  if (startDate === endDate) return `${WEEKDAYS[e.weekday]}, ${MONTHS[e.month]} ${e.day}, ${e.year}`;
  if (s.year !== e.year) return `${short(s.month)} ${s.day}, ${s.year} – ${short(e.month)} ${e.day}, ${e.year}`;
  if (s.month !== e.month) return `${short(s.month)} ${s.day} – ${short(e.month)} ${e.day}, ${e.year}`;
  return `${short(s.month)} ${s.day} – ${e.day}, ${e.year}`;
}

/** The line under the big number. */
export function periodPhrase(range: StoryData['range']): string {
  switch (range) {
    case 'today':
      return 'tokens burned today';
    case '7d':
      return 'tokens burned this week';
    case '30d':
      return 'tokens burned in 30 days';
    case '1y':
      return 'tokens burned in 12 months';
  }
}

/** The big number split into figure and unit, so the unit can be set smaller: "48.2" + "M". */
export function heroNumber(value: number): { figure: string; unit: string } {
  const scales = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const;
  for (const [size, unit] of scales) {
    if (value >= size) {
      const scaled = value / size;
      return { figure: scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1), unit };
    }
  }
  return { figure: String(Math.round(value)), unit: '' };
}

/** Dollars short enough for a stat column: cents below $1,000, whole dollars below $100K, then K and M. */
export function compactDollars(value: number): string {
  if (value < 1_000) return formatDollars(value);
  if (value < 100_000) return formatDollars(value).slice(0, -3);
  if (value < 1_000_000) return `$${Math.round(value / 1_000)}K`;
  return `$${(value / 1_000_000).toFixed(2)}M`;
}

/** "$31.20", or "≥ $31.20" when part of the period could not be priced (unpriced is unknown, never $0). */
export function costLabel(cost: StoryData['cost']): string | null {
  if (cost === null) return null;
  return `${cost.complete ? '' : '≥ '}${compactDollars(cost.dollars)}`;
}

/** A handle cut to `max` characters with an ellipsis; GitHub allows 39, which no card row fits. */
export function shortHandle(handle: string, max: number): string {
  return handle.length > max ? `${handle.slice(0, max - 1)}…` : handle;
}

/** The largest font size up to `max` at which `text` fits `width`, given the face's average advance in em. */
export function fitFont(text: string, width: number, max: number, advance = 0.6): number {
  return Math.min(max, Math.floor(width / (Math.max(1, text.length) * advance)));
}

/** "53%", "<1%" for a real but tiny share. */
export function shareLabel(share: number): string {
  const rounded = Math.round(share * 100);
  return rounded === 0 && share > 0 ? '<1%' : `${rounded}%`;
}

/** The top `count` models by name, with everything after them folded into one "+N more" row. */
export function topModels<T extends { weighted: number; share: number }>(
  models: readonly T[],
  count: number,
): { shown: T[]; rest: { count: number; weighted: number; share: number } | null } {
  if (models.length <= count) return { shown: [...models], rest: null };
  const shown = models.slice(0, count - 1);
  const others = models.slice(count - 1);
  return {
    shown,
    rest: {
      count: others.length,
      weighted: others.reduce((sum, model) => sum + model.weighted, 0),
      share: others.reduce((sum, model) => sum + model.share, 0),
    },
  };
}

export interface StoryStat {
  label: string;
  value: string;
}

/**
 * The three numbers under a card: cost (when it is known and the person wants it shown), then the
 * streak and model count for one day, or active days and the best day for a longer period. When cost
 * drops out, the cache hit rate takes its place, so the row always has three.
 */
export function storyStats(data: StoryData, showCost: boolean): StoryStat[] {
  const stats: StoryStat[] = [];
  const cost = showCost ? costLabel(data.cost) : null;
  if (cost) {
    stats.push({ label: 'Est. API cost', value: cost });
  } else {
    const hit = cacheHitRate(data.counts);
    if (hit !== null) stats.push({ label: 'Cache hits', value: `${Math.round(hit * 100)}%` });
  }
  if (data.range === 'today') {
    // A streak of zero is nothing to post; the slot goes to the next number instead.
    if (data.streak > 0) stats.push({ label: 'Streak', value: `${data.streak} ${data.streak === 1 ? 'day' : 'days'}` });
    stats.push({ label: 'Models', value: String(data.models.length) });
  } else {
    stats.push({ label: 'Active days', value: String(data.activeDays) });
    if (data.peak) stats.push({ label: 'Best day', value: formatTokens(data.peak.weighted) });
  }
  return stats.slice(0, 3);
}
