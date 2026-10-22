import { allLedgerHours, allLedgerUsage, type Ledger } from '../ledger.js';
import { shortDate } from './dates.js';
import {
  addCounts,
  addDays,
  agentName,
  buildGraphGrid,
  cacheSavingsForSplitCounts,
  costForSplitCounts,
  displayModelName,
  emptyCounts,
  formatDollars,
  KNOWN_SOURCES,
  modelFamily,
  modelLabel,
  MODEL_FAMILIES,
  weightedTokens,
  type GraphGrid,
  type ModelFamily,
  type TokenCounts,
} from '@tokengraph/core';

export type RangeKey = '7d' | '30d' | '90d' | '1y' | 'all';
export const RANGES: readonly RangeKey[] = ['7d', '30d', '90d', '1y', 'all'];
export const RANGE_LABELS: Record<RangeKey, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
  all: 'All time',
};

/** About one novel of output, for the "novels written" insight. */
export const NOVEL_TOKENS = 120_000;

const STREAK_CAP = 400;
const GRID_DAYS = 364;
const SERIES_DAYS = 30;

export interface CostSummary {
  dollars: number;
  pricedWeighted: number;
  unpricedWeighted: number;
  /** Dollars prompt caching saved against full input price, over priced rows. */
  cacheSaved: number;
}
export interface Share {
  key: string;
  name: string;
  family: ModelFamily | null;
  weighted: number;
}

export interface DayRow {
  date: string;
  weighted: number;
  counts: TokenCounts;
  topFamily: ModelFamily | null;
  /** key = model label, family set; sorted by weighted desc. */
  models: Share[];
  /** key = source, name = agentName(source), family null; sorted by weighted desc. */
  agents: Share[];
  cost: CostSummary;
}

export interface Streak {
  length: number;
  start: string;
  end: string;
}

/** One ledger entry (source, date, model, pricing tier) with its cost worked out, kept for the breakdowns. */
interface UsageRow {
  source: string;
  date: string;
  label: string;
  counts: TokenCounts;
  cost: CostSummary;
}

export interface ViewModel {
  today: string;
  /** Days with any usage, ascending. Days after `today` (clock skew) are kept here but ignored everywhere else. */
  days: DayRow[];
  byDate: Map<string, DayRow>;
  firstDay: string | null;
  /** Sources with at least one ledger day. */
  sources: string[];
  /** Per-entry rows behind `days`, for the breakdowns' counts and cost. */
  rows: UsageRow[];
  /** Weighted tokens per local (date, hour), all agents together, ascending; empty when no adapter has hour data yet. */
  hours: HourCell[];
}

export interface HourCell {
  date: string;
  hour: number;
  weighted: number;
}

/** The 24-hour picture of the hour data: totals per hour, the busiest hour and a weekday × hour grid. */
export interface HourProfile {
  /** Weighted tokens per local hour, index 0..23. */
  byHour: number[];
  total: number;
  /** The busiest hour and its share (0..1) of all hour data; null without data. */
  busiest: { hour: number; share: number } | null;
  /** First date with hour data (older days have none: logs were pruned or predate the feature). */
  firstDate: string | null;
  /** Weekday (Monday first) × hour, weighted tokens. */
  grid: number[][];
}

export interface Stats {
  today: number;
  week: number;
  weekDelta: number | null;
  streak: number;
  longest: Streak | null;
}

export interface RangeTotals {
  weighted: number;
  counts: TokenCounts;
  cost: CostSummary;
  activeDays: number;
}

export interface Breakdown {
  key: string;
  name: string;
  family: ModelFamily | null;
  weighted: number;
  /** 0..1 of the range total; 0 when the total is 0. */
  share: number;
  counts: TokenCounts;
  cost: CostSummary;
  lastActive: string;
  /** Weighted per day for the 30 days ending today, oldest first (always length 30). */
  daily30: number[];
}

export interface Insights {
  longest: Streak | null;
  record: { date: string; weighted: number } | null;
  favourite: { name: string; family: ModelFamily; weighted: number } | null;
  /** Average weighted per weekday over the 52 weeks ending today, Monday first (length 7). */
  weekdays: number[];
  activeDays: number;
  firstDay: string | null;
  outputTokens: number;
  /** outputTokens / NOVEL_TOKENS. */
  novels: number;
}

function emptyCost(): CostSummary {
  return { dollars: 0, pricedWeighted: 0, unpricedWeighted: 0, cacheSaved: 0 };
}

function addCost(a: CostSummary, b: CostSummary): CostSummary {
  return {
    dollars: a.dollars + b.dollars,
    pricedWeighted: a.pricedWeighted + b.pricedWeighted,
    unpricedWeighted: a.unpricedWeighted + b.unpricedWeighted,
    cacheSaved: a.cacheSaved + b.cacheSaved,
  };
}

/** UTC date-key arithmetic, so results never depend on the host time zone. */
export function shiftDate(date: string, days: number): string {
  return addDays(new Date(`${date}T00:00:00Z`), days).toISOString().slice(0, 10);
}

/** First day of a range (inclusive), or null for 'all'. */
export function rangeStart(range: RangeKey, today: string): string | null {
  switch (range) {
    case '7d':
      return shiftDate(today, -6);
    case '30d':
      return shiftDate(today, -29);
    case '90d':
      return shiftDate(today, -89);
    case '1y':
      return shiftDate(today, -364);
    case 'all':
      return null;
  }
}

function sortShares(shares: Share[]): Share[] {
  return shares.sort((a, b) => b.weighted - a.weighted || a.key.localeCompare(b.key));
}

function buildDay(date: string, rows: UsageRow[], families: Map<string, ModelFamily>): DayRow {
  let counts = emptyCounts();
  let cost = emptyCost();
  const byLabel = new Map<string, TokenCounts>();
  const bySource = new Map<string, TokenCounts>();
  for (const row of rows) {
    counts = addCounts(counts, row.counts);
    cost = addCost(cost, row.cost);
    byLabel.set(row.label, addCounts(byLabel.get(row.label) ?? emptyCounts(), row.counts));
    bySource.set(row.source, addCounts(bySource.get(row.source) ?? emptyCounts(), row.counts));
  }

  const familyWeighted = new Map<ModelFamily, number>();
  const models = [...byLabel].map(([label, labelCounts]): Share => {
    const family = families.get(label) ?? 'other';
    const weighted = weightedTokens(labelCounts);
    familyWeighted.set(family, (familyWeighted.get(family) ?? 0) + weighted);
    return { key: label, name: displayModelName(label), family, weighted };
  });
  const agents = [...bySource].map(
    ([source, sourceCounts]): Share => ({
      key: source,
      name: agentName(source),
      family: null,
      weighted: weightedTokens(sourceCounts),
    }),
  );

  let topFamily: ModelFamily | null = null;
  let best = 0;
  for (const family of MODEL_FAMILIES) {
    const weighted = familyWeighted.get(family) ?? 0;
    if (weighted > best) {
      best = weighted;
      topFamily = family;
    }
  }
  const weighted = weightedTokens(counts);
  return {
    date,
    weighted,
    counts,
    topFamily: weighted > 0 ? topFamily : null,
    models: sortShares(models),
    agents: sortShares(agents),
    cost,
  };
}

/** Turns the local ledger into per-day rows; all later numbers derive from these. */
export function buildViewModel(ledger: Ledger, today: string): ViewModel {
  const rows: UsageRow[] = [];
  const sources: string[] = [];
  // The family of a label comes from the first raw model id seen for it.
  const families = new Map<string, ModelFamily>();

  // Cursor's account figures replace its hook and import rows where they overlap (core's combining rule).
  const combined = allLedgerUsage(ledger);
  for (const source of KNOWN_SOURCES) {
    const usage = combined.filter((entry) => entry.source === source);
    if (usage.length === 0) continue;
    sources.push(source);
    for (const entry of usage) {
      const { counts } = entry;
      const base: TokenCounts = {
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
        cacheCreationTokens: counts.cacheCreationTokens,
        cacheReadTokens: counts.cacheReadTokens,
      };
      if (Object.values(base).every((value) => value === 0)) continue;
      const label = modelLabel(entry.model);
      if (!families.has(label)) families.set(label, modelFamily(entry.model));
      const priced = costForSplitCounts(entry.model, entry.date, counts, entry.pricingTier);
      const weighted = weightedTokens(base);
      const cost: CostSummary = priced.priced
        ? {
            dollars: priced.dollars,
            pricedWeighted: weighted,
            unpricedWeighted: 0,
            cacheSaved: cacheSavingsForSplitCounts(entry.model, entry.date, counts, entry.pricingTier) ?? 0,
          }
        : { dollars: 0, pricedWeighted: 0, unpricedWeighted: weighted, cacheSaved: 0 };
      rows.push({ source, date: entry.date, label, counts: base, cost });
    }
  }

  const rowsByDate = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const list = rowsByDate.get(row.date);
    if (list) list.push(row);
    else rowsByDate.set(row.date, [row]);
  }
  const days = [...rowsByDate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => buildDay(date, dayRows, families));
  return {
    today,
    days,
    byDate: new Map(days.map((day) => [day.date, day])),
    firstDay: days[0]?.date ?? null,
    sources,
    rows,
    hours: buildHours(ledger, today),
  };
}

function buildHours(ledger: Ledger, today: string): HourCell[] {
  const sums = new Map<string, HourCell>();
  for (const row of allLedgerHours(ledger)) {
    if (row.date > today) continue;
    const key = `${row.date}\0${row.hour}`;
    const cell = sums.get(key);
    if (cell) cell.weighted += row.weighted;
    else sums.set(key, { date: row.date, hour: row.hour, weighted: row.weighted });
  }
  return [...sums.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
}

/** Hour-of-day profile over all hour data in the ledger (hour data is already limited to what logs still hold). */
export function hourProfile(vm: ViewModel): HourProfile {
  const byHour = new Array<number>(24).fill(0);
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  for (const { date, hour, weighted } of vm.hours) {
    byHour[hour] = (byHour[hour] ?? 0) + weighted;
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    grid[weekday]![hour] = (grid[weekday]![hour] ?? 0) + weighted;
    total += weighted;
  }
  let busiest: HourProfile['busiest'] = null;
  if (total > 0) {
    const max = Math.max(...byHour);
    const hour = byHour.indexOf(max);
    busiest = { hour, share: max / total };
  }
  return { byHour, total, busiest, firstDate: vm.hours[0]?.date ?? null, grid };
}

/** "22–23h": the busiest hour as a range (the last hour of the day ends at 0h). */
export function hourRange(hour: number): string {
  return `${hour}–${(hour + 1) % 24}h`;
}

/** "22–23h · 18%" */
export function busiestHourText(profile: HourProfile): string | null {
  return profile.busiest ? `${hourRange(profile.busiest.hour)} · ${Math.round(profile.busiest.share * 100)}%` : null;
}

function weightedOn(vm: ViewModel, date: string): number {
  return date > vm.today ? 0 : (vm.byDate.get(date)?.weighted ?? 0);
}

function sumDays(vm: ViewModel, endDate: string, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i += 1) total += weightedOn(vm, shiftDate(endDate, -i));
  return total;
}

/** Days up to today with weighted tokens, ascending — the days every metric counts. */
function activeDaysUpToToday(vm: ViewModel): DayRow[] {
  return vm.days.filter((day) => day.date <= vm.today && day.weighted > 0);
}

function longestStreak(days: readonly DayRow[]): Streak | null {
  let longest: Streak | null = null;
  let run: Streak | null = null;
  for (const day of days) {
    run = run && shiftDate(run.end, 1) === day.date
      ? { length: run.length + 1, start: run.start, end: day.date }
      : { length: 1, start: day.date, end: day.date };
    // >= so a tie goes to the most recent run.
    if (!longest || run.length >= longest.length) longest = run;
  }
  return longest;
}

function currentStreak(vm: ViewModel): number {
  let cursor = weightedOn(vm, vm.today) > 0 ? vm.today : shiftDate(vm.today, -1);
  let length = 0;
  while (length < STREAK_CAP && weightedOn(vm, cursor) > 0) {
    length += 1;
    cursor = shiftDate(cursor, -1);
  }
  return length;
}

/** Today, the last 7 days against the 7 before, and the streaks. */
export function stats(vm: ViewModel): Stats {
  const week = sumDays(vm, vm.today, 7);
  const previous = sumDays(vm, shiftDate(vm.today, -7), 7);
  return {
    today: weightedOn(vm, vm.today),
    week,
    weekDelta: previous > 0 ? (week - previous) / previous : null,
    streak: currentStreak(vm),
    longest: longestStreak(activeDaysUpToToday(vm)),
  };
}

function inRange(vm: ViewModel, range: RangeKey) {
  const start = rangeStart(range, vm.today);
  return (date: string) => date <= vm.today && (start === null || date >= start);
}

/** Totals over a range: weighted is the sum of daily weighted, so it matches the graph. */
export function rangeTotals(vm: ViewModel, range: RangeKey): RangeTotals {
  const include = inRange(vm, range);
  let weighted = 0;
  let activeDays = 0;
  for (const day of vm.days) {
    if (!include(day.date)) continue;
    weighted += day.weighted;
    if (day.weighted > 0) activeDays += 1;
  }
  let counts = emptyCounts();
  let cost = emptyCost();
  for (const row of vm.rows) {
    if (!include(row.date)) continue;
    counts = addCounts(counts, row.counts);
    cost = addCost(cost, row.cost);
  }
  return { weighted, counts, cost, activeDays };
}

function breakdown(vm: ViewModel, range: RangeKey, byModel: boolean): Breakdown[] {
  const include = inRange(vm, range);
  const total = rangeTotals(vm, range).weighted;
  const entries = new Map<string, Breakdown>();

  for (const day of vm.days) {
    if (!include(day.date)) continue;
    for (const share of byModel ? day.models : day.agents) {
      let entry = entries.get(share.key);
      if (!entry) {
        entry = {
          key: share.key,
          name: share.name,
          family: share.family,
          weighted: 0,
          share: 0,
          counts: emptyCounts(),
          cost: emptyCost(),
          lastActive: day.date,
          daily30: new Array<number>(SERIES_DAYS).fill(0),
        };
        entries.set(share.key, entry);
      }
      entry.weighted += share.weighted;
      entry.lastActive = day.date; // days ascend, so the last write is the latest
    }
  }
  // The sparkline is a fixed 30-day window ending today, whatever range chose the rows.
  const seriesStart = shiftDate(vm.today, -(SERIES_DAYS - 1));
  for (const day of vm.days) {
    if (day.date < seriesStart || day.date > vm.today) continue;
    const index = SERIES_DAYS - 1 - daysBetween(day.date, vm.today);
    for (const share of byModel ? day.models : day.agents) {
      const entry = entries.get(share.key);
      if (entry) entry.daily30[index] = (entry.daily30[index] ?? 0) + share.weighted;
    }
  }
  for (const row of vm.rows) {
    const entry = include(row.date) ? entries.get(byModel ? row.label : row.source) : undefined;
    if (!entry) continue;
    entry.counts = addCounts(entry.counts, row.counts);
    entry.cost = addCost(entry.cost, row.cost);
  }

  return [...entries.values()]
    .map((entry) => ({ ...entry, share: total > 0 ? entry.weighted / total : 0 }))
    .sort((a, b) => b.weighted - a.weighted || a.key.localeCompare(b.key));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** One row per model label with usage in the range, biggest first. */
export function modelBreakdown(vm: ViewModel, range: RangeKey): Breakdown[] {
  return breakdown(vm, range, true);
}

/** One row per source with usage in the range, biggest first. */
export function agentBreakdown(vm: ViewModel, range: RangeKey): Breakdown[] {
  return breakdown(vm, range, false);
}

/** All-time highlights plus the weekday profile of the last 52 weeks. */
export function insights(vm: ViewModel): Insights {
  const days = activeDaysUpToToday(vm);
  let record: Insights['record'] = null;
  let outputTokens = 0;
  const models = new Map<string, { name: string; family: ModelFamily; weighted: number }>();
  for (const day of days) {
    if (!record || day.weighted > record.weighted) record = { date: day.date, weighted: day.weighted };
    outputTokens += day.counts.outputTokens;
    for (const share of day.models) {
      const entry = models.get(share.key) ?? { name: share.name, family: share.family ?? 'other', weighted: 0 };
      entry.weighted += share.weighted;
      models.set(share.key, entry);
    }
  }
  // Insertion order is chronological, so a tie goes to the model seen first.
  let favourite: Insights['favourite'] = null;
  for (const entry of models.values()) {
    if (entry.weighted > 0 && (!favourite || entry.weighted > favourite.weighted)) favourite = { ...entry };
  }

  const weekdays = new Array<number>(7).fill(0);
  for (let i = 0; i < GRID_DAYS; i += 1) {
    const date = shiftDate(vm.today, -i);
    const monday0 = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    weekdays[monday0] = (weekdays[monday0] ?? 0) + weightedOn(vm, date);
  }

  return {
    longest: longestStreak(days),
    record,
    favourite,
    weekdays: weekdays.map((sum) => sum / 52),
    activeDays: days.length,
    firstDay: vm.firstDay,
    outputTokens,
    novels: outputTokens / NOVEL_TOKENS,
  };
}

/** The 52-week grid ending on `endDate`, levels computed from the days inside that window only. */
export function yearGrid(vm: ViewModel, endDate: string): GraphGrid {
  const start = shiftDate(endDate, -(GRID_DAYS - 1));
  const days = vm.days
    .filter((day) => day.date >= start && day.date <= endDate)
    .map((day) => ({ date: day.date, weighted: day.weighted, topFamily: day.topFamily }));
  return buildGraphGrid(days, endDate);
}

/** Weighted per day for the `count` days ending `endDate`, oldest first. */
export function dailySeries(vm: ViewModel, endDate: string, count: number): number[] {
  return Array.from({ length: count }, (_, i) => vm.byDate.get(shiftDate(endDate, i - count + 1))?.weighted ?? 0);
}

export interface FamilyDay {
  date: string;
  weighted: number;
  families: { family: ModelFamily; weighted: number }[];
}

/** A day's weighted split by model family (MODEL_FAMILIES order, zero families omitted). */
function dayFamilies(day: DayRow): { family: ModelFamily; weighted: number }[] {
  const byFamily = new Map<ModelFamily, number>();
  for (const share of day.models) {
    const family = share.family ?? 'other';
    byFamily.set(family, (byFamily.get(family) ?? 0) + share.weighted);
  }
  return MODEL_FAMILIES.flatMap((family) => {
    const weighted = byFamily.get(family) ?? 0;
    return weighted > 0 ? [{ family, weighted }] : [];
  });
}

/** `count` days ending `endDate`, oldest first; each day's weighted split by model family (MODEL_FAMILIES order, zero families omitted). */
export function familySeries(vm: ViewModel, endDate: string, count: number): FamilyDay[] {
  return Array.from({ length: count }, (_, i): FamilyDay => {
    const date = shiftDate(endDate, i - count + 1);
    const day = vm.byDate.get(date);
    if (!day) return { date, weighted: 0, families: [] };
    return { date, weighted: day.weighted, families: dayFamilies(day) };
  });
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_MONTH_BUCKETS = 36;

/** One chart column: the days from `start` to `end` inclusive. */
export interface Bucket {
  label: string;
  start: string;
  end: string;
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function monthBucket(index: number, today: string, label: string): Bucket {
  const year = Math.floor(index / 12);
  const month = index % 12;
  const start = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { label, start, end: last > today ? today : last };
}

function monthLabel(index: number, today: string): string {
  const name = MONTH_NAMES[index % 12]!;
  const year = Math.floor(index / 12);
  return year === Number(today.slice(0, 4)) ? name : `${name} ${String(year % 100).padStart(2, '0')}`;
}

/** The chart buckets for a range: 7d → 7 days, 30d → 30, 90d → 90, 1y → 52 weeks, all → months since the first day (1 to 36). */
export function rangeBuckets(vm: ViewModel, range: RangeKey): Bucket[] {
  const { today } = vm;
  const days = (count: number): Bucket[] =>
    Array.from({ length: count }, (_, i) => {
      const date = shiftDate(today, i - count + 1);
      return { label: shortDate(date), start: date, end: date };
    });
  switch (range) {
    case '7d':
      return days(7);
    case '30d':
      return days(30);
    case '90d':
      return days(90);
    case '1y':
      return Array.from({ length: 52 }, (_, i) => {
        const end = shiftDate(today, -7 * (51 - i));
        const start = shiftDate(end, -6);
        return { label: shortDate(start), start, end };
      });
    case 'all': {
      const last = monthIndex(today);
      const first = Math.max(vm.firstDay === null ? last : Math.min(monthIndex(vm.firstDay), last), last - (MAX_MONTH_BUCKETS - 1));
      return Array.from({ length: last - first + 1 }, (_, i) => monthBucket(first + i, today, monthLabel(first + i, today)));
    }
  }
}

function eachDayIn(vm: ViewModel, bucket: Bucket): DayRow[] {
  return vm.days.filter((day) => day.date >= bucket.start && day.date <= bucket.end && day.date <= vm.today);
}

/** Per bucket, weighted split by model family (like familySeries). */
export function familyBuckets(
  vm: ViewModel,
  buckets: readonly Bucket[],
): { bucket: Bucket; weighted: number; families: { family: ModelFamily; weighted: number }[] }[] {
  return buckets.map((bucket) => {
    const byFamily = new Map<ModelFamily, number>();
    let weighted = 0;
    for (const day of eachDayIn(vm, bucket)) {
      weighted += day.weighted;
      for (const f of dayFamilies(day)) byFamily.set(f.family, (byFamily.get(f.family) ?? 0) + f.weighted);
    }
    const families = MODEL_FAMILIES.flatMap((family) => {
      const value = byFamily.get(family) ?? 0;
      return value > 0 ? [{ family, weighted: value }] : [];
    });
    return { bucket, weighted, families };
  });
}

/** Per bucket, weighted split by agent source (sources ordered by all-time weighted, descending). */
export function agentBuckets(
  vm: ViewModel,
  buckets: readonly Bucket[],
): { bucket: Bucket; weighted: number; agents: { source: string; weighted: number }[] }[] {
  const order = agentBreakdown(vm, 'all').map((a) => a.key);
  return buckets.map((bucket) => {
    const bySource = new Map<string, number>();
    let weighted = 0;
    for (const day of eachDayIn(vm, bucket)) {
      weighted += day.weighted;
      for (const share of day.agents) bySource.set(share.key, (bySource.get(share.key) ?? 0) + share.weighted);
    }
    const agents = order.flatMap((source) => {
      const value = bySource.get(source) ?? 0;
      return value > 0 ? [{ source, weighted: value }] : [];
    });
    return { bucket, weighted, agents };
  });
}

/** Weighted per calendar month for the 12 months ending with today's month, oldest first; label 'Oct' etc. */
export function monthlyTotals(vm: ViewModel): { label: string; weighted: number }[] {
  const last = monthIndex(vm.today);
  return Array.from({ length: 12 }, (_, i) => {
    const index = last - 11 + i;
    const bucket = monthBucket(index, vm.today, MONTH_NAMES[index % 12]!);
    return { label: bucket.label, weighted: eachDayIn(vm, bucket).reduce((sum, day) => sum + day.weighted, 0) };
  });
}

/** The cost line: never `$0` for unpriced usage. */
export function formatCost(cost: CostSummary): string {
  if (cost.pricedWeighted + cost.unpricedWeighted === 0) return '$0.00';
  if (cost.pricedWeighted === 0) return 'cost unknown';
  return `≈ ${formatDollars(cost.dollars)}${cost.unpricedWeighted > 0 ? ' + unpriced' : ''}`;
}
