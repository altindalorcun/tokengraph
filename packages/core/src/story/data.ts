import { FAMILY_RAMPS } from '../graph-colors.js';
import { toGraphDaysByFamily } from '../graph-days.js';
import { computeThresholds, levelFor, type Level } from '../levels.js';
import { familyForMaker, MODEL_FAMILIES, type Maker, type ModelFamily } from '../model-makers.js';
import type { TokenCounts } from '../tokens.js';
import { modelBreakdown, sumCounts, type ModelDayTotals } from './aggregate.js';
import { costBreakdown, type CostRow } from './cost.js';
import type { StoryRange } from './options.js';
import { rangeWindow, shiftDate } from './range.js';
import { summarizeStats } from './stats.js';

/**
 * Everything a story card prints, worked out once from the same rows the dashboard reads. The
 * cards themselves only lay this out; every number here follows the dashboard's rules (days are
 * weighted first and then summed, unpriced is unknown and never $0, levels are the person's own
 * percentiles), so a card never disagrees with the page it was shared from.
 */

export interface StoryModel {
  name: string;
  family: ModelFamily;
  maker: Maker | null;
  weighted: number;
  share: number;
  /** A shade of the family's hue for a dark card: heavier models of one family get the brighter shade. */
  color: string;
}

export interface StoryDay {
  date: string;
  weighted: number;
  level: Level;
  /** The family that burned most of the day, which gives the day its hue. null on an idle day. */
  family: ModelFamily | null;
  /** Inside the shared period; the rest of the skyline is context and drawn dimmed. */
  inPeriod: boolean;
}

export interface StoryHighlight {
  /** Short badge text, e.g. "Personal best" or "Top 5% day". */
  label: string;
  kind: 'best' | 'top' | 'streak';
}

export interface StoryData {
  handle: string;
  range: StoryRange;
  startDate: string;
  endDate: string;
  /** Weighted tokens in the period: each day weighted, then summed, as the graph does. */
  total: number;
  /** Raw counts summed over the period, for the receipt's line items. */
  counts: TokenCounts;
  /** Every model in the period, heaviest first. */
  models: StoryModel[];
  /** The family with the most weighted tokens in the period: the card's accent. */
  family: ModelFamily;
  /** null when nothing in the period could be priced; `complete: false` makes the figure a lower bound. */
  cost: { dollars: number; complete: boolean } | null;
  streak: number;
  activeDays: number;
  /** The heaviest day of the period (multi-day periods only). */
  peak: { date: string; weighted: number } | null;
  highlight: StoryHighlight | null;
  /** Whole weeks ending with the period's last day, Sunday first, oldest week first. Future days are null. */
  weeks: (StoryDay | null)[][];
  /** Made-up data for the landing page and signed-out visitors. */
  demo: boolean;
}

export interface StoryInput {
  handle: string;
  range: StoryRange;
  todayUtc: string;
  /** Per-day, per-model rows reaching back at least a year, so levels and the streak have history. */
  rows: readonly ModelDayTotals[];
  /** Cost inputs covering at least the period. */
  costRows: readonly CostRow[];
  demo?: boolean;
}

/** Brightest shade first: the heaviest model of a family gets the boldest colour. */
const SHADE_LEVELS = [5, 3, 2] as const;

const MIN_WEEKS = 12;
const YEAR_WEEKS = 53;

/**
 * Weeks of context the skyline shows: a quarter for the short periods; for 12 months, the weeks
 * since the first usage in the window (a quarter at least, a year at most), so a young account's
 * city is not a long empty runway.
 */
export function skylineWeeks(range: StoryRange, endDate?: string, firstUsage?: string | null): number {
  if (range !== '1y') return MIN_WEEKS;
  if (!endDate || !firstUsage) return YEAR_WEEKS;
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${firstUsage}T00:00:00Z`)) / 86_400_000);
  // The grid starts on the Sunday `weekday + 7 × (weeks − 1)` days back; it must reach the first usage.
  const weeks = Math.ceil((days - weekday(endDate)) / 7) + 1;
  return Math.min(YEAR_WEEKS, Math.max(MIN_WEEKS, weeks));
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function storyModels(rows: readonly ModelDayTotals[], window: { startDate: string; endDate: string }): StoryModel[] {
  const ranks = new Map<ModelFamily, number>();
  return modelBreakdown(rows, window)
    .filter((model) => model.weighted > 0)
    .map((model) => {
      const family = familyForMaker(model.maker);
      const rank = ranks.get(family) ?? 0;
      ranks.set(family, rank + 1);
      const level = SHADE_LEVELS[Math.min(rank, SHADE_LEVELS.length - 1)]!;
      return {
        name: model.name,
        family,
        maker: model.maker,
        weighted: model.weighted,
        share: model.share,
        color: FAMILY_RAMPS[family][level],
      };
    });
}

function dominantFamily(models: readonly StoryModel[]): ModelFamily {
  const byFamily = new Map<ModelFamily, number>();
  for (const model of models) byFamily.set(model.family, (byFamily.get(model.family) ?? 0) + model.weighted);
  let best: ModelFamily = 'other';
  let bestWeight = 0;
  // MODEL_FAMILIES order breaks ties, the way the graph picks a day's hue.
  for (const family of MODEL_FAMILIES) {
    const weight = byFamily.get(family) ?? 0;
    if (weight > bestWeight) {
      best = family;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * A badge worth bragging about, from the person's own history only. A one-day card can be a
 * personal best (the heaviest day of the loaded year) or a top-decile day; a longer period falls
 * back to a streak of a week or more. Nothing when none of these is true: a badge on every card
 * would mean nothing.
 */
export function storyHighlight(
  range: StoryRange,
  total: number,
  history: readonly number[],
  streak: number,
): StoryHighlight | null {
  if (range === 'today' && total > 0) {
    const others = history.filter((value) => value > 0);
    if (others.length >= 7) {
      const max = Math.max(...others);
      if (total >= max) return { label: 'Personal best', kind: 'best' };
      const above = others.filter((value) => value > total).length;
      const top = Math.ceil(((above + 1) / others.length) * 100);
      if (top <= 10) return { label: `Top ${top}% day`, kind: 'top' };
    }
  }
  if (streak >= 7) return { label: `${streak}-day streak`, kind: 'streak' };
  return null;
}

export function buildStory(input: StoryInput): StoryData {
  const { rows, range, todayUtc } = input;
  const days = toGraphDaysByFamily(rows);
  const window = rangeWindow(range, todayUtc, days.map((day) => day.date));
  const inPeriod = (date: string) => date >= window.startDate && date <= window.endDate;

  const periodDays = days.filter((day) => inPeriod(day.date) && day.weighted > 0);
  const total = periodDays.reduce((sum, day) => sum + day.weighted, 0);
  const periodRows = rows.filter((row) => inPeriod(row.date));
  const models = storyModels(rows, window);

  const cost = costBreakdown(input.costRows, window);
  const priced = cost.pricedSinceDate !== null;

  // Levels come from the person's own year, the same percentiles the graph uses.
  const thresholds = computeThresholds(days.map((day) => day.weighted));
  const byDate = new Map(days.map((day) => [day.date, day]));

  const weekCount = skylineWeeks(range, window.endDate, periodDays[0]?.date ?? null);
  const firstDay = shiftDate(window.endDate, -(weekday(window.endDate) + (weekCount - 1) * 7));
  const weeks: (StoryDay | null)[][] = [];
  for (let week = 0; week < weekCount; week += 1) {
    const column: (StoryDay | null)[] = [];
    for (let dow = 0; dow < 7; dow += 1) {
      const date = shiftDate(firstDay, week * 7 + dow);
      if (date > window.endDate) {
        column.push(null);
        continue;
      }
      const day = byDate.get(date);
      const weighted = day?.weighted ?? 0;
      column.push({
        date,
        weighted,
        level: levelFor(weighted, thresholds),
        family: weighted > 0 ? (day?.topFamily ?? null) : null,
        inPeriod: inPeriod(date),
      });
    }
    weeks.push(column);
  }

  const streak = summarizeStats(days, window.endDate).streak;
  const peakDay = periodDays.reduce<(typeof periodDays)[number] | null>(
    (best, day) => (best === null || day.weighted > best.weighted ? day : best),
    null,
  );
  const history = days.filter((day) => day.date < window.startDate).map((day) => day.weighted);

  return {
    handle: input.handle,
    range,
    startDate: window.startDate,
    endDate: window.endDate,
    total,
    counts: sumCounts(periodRows.map((row) => ({ counts: row }))),
    models,
    family: dominantFamily(models),
    cost: priced ? { dollars: cost.totalDollars, complete: cost.complete } : null,
    streak,
    activeDays: periodDays.length,
    peak: range === 'today' || peakDay === null ? null : { date: peakDay.date, weighted: peakDay.weighted },
    highlight: storyHighlight(range, total, history, streak),
    weeks,
    demo: input.demo ?? false,
  };
}
