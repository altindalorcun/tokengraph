const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Calendar day an instant falls on, as YYYY-MM-DD. Defaults to the system time zone. */
export function dateKey(instant: Date, timeZone?: string): string {
  return formatterFor(timeZone).format(instant);
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Local hour of day (0-23) an instant falls in, in the same time zone rule as {@link dateKey}.
 * Intl does the zone arithmetic, so a day with a daylight-saving change simply has no hour 2 (spring)
 * or two instants in hour 1 (autumn), exactly as a wall clock shows it.
 */
export function hourKey(instant: Date, timeZone?: string): number {
  const key = timeZone ?? '';
  let formatter = hourFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    hourFormatters.set(key, formatter);
  }
  return Number(formatter.format(instant)) % 24;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
