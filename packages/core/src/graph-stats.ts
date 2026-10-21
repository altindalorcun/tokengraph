import type { GraphGrid } from './graph.js';
import { MODEL_FAMILIES, type ModelFamily } from './model-makers.js';

/**
 * The numbers the README graph's stats strip shows. Everything here is derived from the drawn
 * cells, which carry daily totals and a family name only, so the public gist learns nothing it
 * did not already show.
 */
export interface GraphStats {
  /** Days drawn in the grid (a grid ends on its end date, so this is 364 or fewer). */
  windowDays: number;
  activeDays: number;
  total: number;
  /** First and last drawn day, null for a grid with no cells. */
  firstDate: string | null;
  lastDate: string | null;
  /**
   * Consecutive active days ending today. A today without tokens yet does not break the run:
   * the count then ends yesterday.
   */
  currentStreak: number;
  longestStreak: number;
  /** The busiest day; the earliest one on a tie. Null when no day has tokens. */
  bestDay: { date: string; weighted: number } | null;
  /** The family that led the most active days; a tie goes to the earlier family in family order. */
  topFamily: { family: ModelFamily; days: number } | null;
}

export function computeGraphStats(grid: GraphGrid): GraphStats {
  const cells = grid.columns.flat().filter((cell) => cell !== null);

  let longestStreak = 0;
  let run = 0;
  let bestDay: GraphStats['bestDay'] = null;
  let activeDays = 0;
  let total = 0;
  const led = new Map<ModelFamily, number>();
  for (const cell of cells) {
    if (cell.weighted > 0) {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
      activeDays += 1;
      total += cell.weighted;
      if (!bestDay || cell.weighted > bestDay.weighted) bestDay = { date: cell.date, weighted: cell.weighted };
      if (cell.topFamily) led.set(cell.topFamily, (led.get(cell.topFamily) ?? 0) + 1);
    } else {
      run = 0;
    }
  }

  let index = cells.length - 1;
  if (index >= 0 && cells[index]!.weighted <= 0) index -= 1;
  let currentStreak = 0;
  while (index >= 0 && cells[index]!.weighted > 0) {
    currentStreak += 1;
    index -= 1;
  }

  let topFamily: GraphStats['topFamily'] = null;
  for (const family of MODEL_FAMILIES) {
    const days = led.get(family) ?? 0;
    if (days > (topFamily?.days ?? 0)) topFamily = { family, days };
  }

  return {
    windowDays: cells.length,
    activeDays,
    total,
    firstDate: cells[0]?.date ?? null,
    lastDate: cells[cells.length - 1]?.date ?? null,
    currentStreak,
    longestStreak,
    bestDay,
    topFamily,
  };
}
