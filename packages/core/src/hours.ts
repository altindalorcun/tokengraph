import { dateKey } from './dates.js';
import { CURSOR_SOURCE, type KnownSource } from './sources.js';
import type { HourlyUsage } from './types.js';

/** date → hour ("0".."23") → weighted tokens. The shape the ledger stores. */
export type HourDays = Record<string, Record<string, number>>;

/** Sums weighted tokens per (date, hour); what an adapter fills while it reads requests. */
export class HourSums {
  private readonly sums = new Map<string, HourlyUsage>();

  add(date: string, hour: number, weighted: number): void {
    if (!(weighted > 0) || !Number.isInteger(hour) || hour < 0 || hour > 23) return;
    const key = `${date}\0${hour}`;
    const existing = this.sums.get(key);
    if (existing) existing.weighted += weighted;
    else this.sums.set(key, { date, hour, weighted });
  }

  toList(): HourlyUsage[] {
    return [...this.sums.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
  }
}

/** One Cursor account's hours: complete up to `coveredThrough`, like its daily figures. */
export interface AccountHours {
  coveredThrough: string;
  hours: HourDays;
}

/** What this machine knows about hours: per source (the `cursor` entry is hook plus import) and per Cursor account. */
export interface MachineHours {
  sources: Readonly<Partial<Record<KnownSource, HourDays>>>;
  accounts: Readonly<Record<string, AccountHours>>;
}

export interface SourcedHourly extends HourlyUsage {
  source: KnownSource;
}

function* rows(days: HourDays | undefined): Generator<HourlyUsage> {
  for (const [date, hours] of Object.entries(days ?? {})) {
    for (const [hour, weighted] of Object.entries(hours)) {
      const h = Number(hour);
      if (Number.isInteger(h) && h >= 0 && h <= 23 && weighted > 0) yield { date, hour: h, weighted };
    }
  }
}

/**
 * Hour data for this machine only (hours never leave it), with the same Cursor rule as the daily
 * `combineMachineUsage`: account hours are summed across accounts and are complete up to the newest
 * `coveredThrough` (local day D). The `cursor` source's hook hours are ignored for days before D; from D on,
 * per (date, hour), the larger of the account sum and the hook hours wins. With no account, nothing is ignored.
 * `timeZone` must be the one the hours were keyed with (default: the system's).
 */
export function combineMachineHours(machine: MachineHours, timeZone?: string): SourcedHourly[] {
  const result: SourcedHourly[] = [];
  const accountTotals = new Map<string, HourlyUsage>();
  let newest: string | null = null;
  for (const account of Object.values(machine.accounts)) {
    if (newest === null || account.coveredThrough > newest) newest = account.coveredThrough;
    for (const row of rows(account.hours)) {
      const key = `${row.date}\0${row.hour}`;
      const existing = accountTotals.get(key);
      accountTotals.set(key, existing ? { ...existing, weighted: existing.weighted + row.weighted } : row);
    }
  }
  const instant = newest === null ? null : new Date(newest);
  const coveredDay = instant && !Number.isNaN(instant.getTime()) ? dateKey(instant, timeZone) : null;

  for (const [source, days] of Object.entries(machine.sources) as [KnownSource, HourDays][]) {
    if (source === CURSOR_SOURCE && coveredDay !== null) continue;
    for (const row of rows(days)) result.push({ ...row, source });
  }

  const cursorRows = new Map<string, HourlyUsage>(accountTotals);
  if (coveredDay !== null) {
    for (const row of rows(machine.sources[CURSOR_SOURCE])) {
      if (row.date < coveredDay) continue;
      const key = `${row.date}\0${row.hour}`;
      const account = cursorRows.get(key);
      cursorRows.set(key, account ? { ...account, weighted: Math.max(account.weighted, row.weighted) } : row);
    }
  }
  for (const row of cursorRows.values()) result.push({ ...row, source: CURSOR_SOURCE });
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour || a.source.localeCompare(b.source));
}
