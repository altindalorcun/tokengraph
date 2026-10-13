import { shiftDate } from './range.js';

export interface DailyWeight {
  date: string;
  weighted: number;
}

export interface Stats {
  today: number;
  week: number;
  /** Change against the seven days before, as a fraction. null when there is nothing to compare. */
  weekDelta: number | null;
  streak: number;
}

/** A streak longer than the graph itself cannot be shown, so the walk stops there. */
const MAX_STREAK_DAYS = 400;

const WEEK = 7;

/**
 * The four tiles above the breakdown. They read the same year of days the graph draws, so a
 * streak can run back further than whichever range tab is selected.
 */
export function summarizeStats(days: readonly DailyWeight[], endDate: string): Stats {
  const byDate = new Map(days.map((day) => [day.date, day.weighted]));
  const at = (offset: number) => byDate.get(shiftDate(endDate, -offset)) ?? 0;

  let week = 0;
  let previous = 0;
  for (let offset = 0; offset < WEEK; offset += 1) {
    week += at(offset);
    previous += at(offset + WEEK);
  }

  return {
    today: at(0),
    week,
    weekDelta: previous > 0 ? (week - previous) / previous : null,
    streak: currentStreak(at),
  };
}

/**
 * Consecutive days with any usage, ending today. A quiet today does not break it — the day is
 * not over — but a quiet yesterday does.
 */
function currentStreak(at: (offset: number) => number): number {
  const start = at(0) > 0 ? 0 : 1;
  let streak = 0;
  for (let offset = start; offset < MAX_STREAK_DAYS; offset += 1) {
    if (at(offset) <= 0) break;
    streak += 1;
  }
  return streak;
}
