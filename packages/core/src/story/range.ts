import { graphEndDate } from '../graph-days.js';

/** null means "everything", which has no fixed length. */
export const RANGES = { today: 1, '7d': 7, '30d': 30, '1y': 365, all: null } as const;
export type RangeKey = keyof typeof RANGES;

export interface RangeWindow {
  /** First day shown, inclusive. */
  startDate: string;
  /** Last day shown, inclusive. */
  endDate: string;
}

/** Shifts a YYYY-MM-DD key by whole calendar days. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every calendar day from start to end, inclusive. */
export function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

/**
 * Like the contribution graph, the window ends on a client's "tomorrow" when it already has
 * usage. All time starts at the earliest day the person has, or the end when they have none.
 */
export function rangeWindow(range: RangeKey, todayUtc: string, dataDates: readonly string[]): RangeWindow {
  const endDate = graphEndDate(todayUtc, dataDates);
  const days = RANGES[range];
  if (days === null) {
    const earliest = dataDates.reduce<string | null>(
      (first, date) => (first === null || date < first ? date : first),
      null,
    );
    return { startDate: earliest ?? endDate, endDate };
  }
  return { startDate: shiftDate(endDate, -(days - 1)), endDate };
}
