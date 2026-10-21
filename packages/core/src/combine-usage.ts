import { dateKey } from './dates.js';
import { CURSOR_SOURCE, type KnownSource } from './sources.js';
import { addSplitCounts, maxSplitCounts } from './tokens.js';
import type { DailyModelUsage } from './types.js';

/** A day of usage that remembers which agent it came from. */
export interface SourcedUsage extends DailyModelUsage {
  source: KnownSource;
}

/** One Cursor account's usage as one machine fetched it from cursor.com. */
export interface AccountUsage {
  /** ISO instant of the last successful fetch: the account figure is complete up to here. */
  coveredThrough: string;
  usage: readonly DailyModelUsage[];
}

/** What one machine knows: every agent's local usage, plus the Cursor accounts it fetched. */
export interface MachineUsage {
  usage: readonly SourcedUsage[];
  /** Keyed by account key (a hash of the Cursor user id). */
  accounts: Readonly<Record<string, AccountUsage>>;
}

const keyOf = (entry: DailyModelUsage): string => JSON.stringify([entry.date, entry.model, entry.pricingTier]);

function addInto(map: Map<string, DailyModelUsage>, entry: DailyModelUsage, how: typeof addSplitCounts): void {
  const key = keyOf(entry);
  const existing = map.get(key);
  map.set(key, existing ? { ...existing, counts: how(existing.counts, entry.counts) } : { ...entry, counts: { ...entry.counts } });
}

/**
 * The one rule for putting machines and Cursor accounts together; every consumer (graph, view, story,
 * export, status) goes through it.
 *
 * - Everything except the Cursor account figures is summed across machines: different machines are
 *   different usage. The result lists them unmerged, as separate rows.
 * - An account's figures are the same data on every machine that fetched it, so per account key the
 *   machines are merged by per-field maximum. Different accounts are different usage and add up.
 * - The `cursor` source (hook events and manual CSV imports) overlaps the account figures. Let `low` be the
 *   OLDEST `coveredThrough` among the accounts (after the per-key merge across machines) and `high` the newest.
 *   Days before `low`'s day are covered by every account: the source is ignored and the accounts are summed.
 *   From `low`'s day on (through `high`'s day and every later day) some account may not have its figure
 *   yet, so per day, model and tier the result is max(sum of the accounts, summed `cursor` source): hooks
 *   show a turn before cursor.com has it, and the account figure wins once it has. A stale second account
 *   (signed out, switched) therefore only keeps the hook rows alive; it never hides them. With one account
 *   `low` = `high`.
 * - With no account at all, nothing is ignored.
 *
 * Account rows carry the `cursor` source and are keyed on UTC days (the fetch folds them that way, so
 * machines in different time zones agree on the keys); the covered day is the UTC day of `low`. The
 * `cursor` source keeps each machine's local days and is compared as is.
 */
export function combineMachineUsage(machines: readonly MachineUsage[]): SourcedUsage[] {
  const accountsByKey = new Map<string, { coveredThrough: string; days: Map<string, DailyModelUsage> }>();
  for (const machine of machines) {
    for (const [accountKey, account] of Object.entries(machine.accounts)) {
      let merged = accountsByKey.get(accountKey);
      if (!merged) {
        merged = { coveredThrough: account.coveredThrough, days: new Map() };
        accountsByKey.set(accountKey, merged);
      } else if (account.coveredThrough > merged.coveredThrough) merged.coveredThrough = account.coveredThrough;
      for (const entry of account.usage) addInto(merged.days, entry, maxSplitCounts);
    }
  }

  const accountTotals = new Map<string, DailyModelUsage>();
  let oldest: Date | null = null;
  for (const account of accountsByKey.values()) {
    const covered = new Date(account.coveredThrough);
    if (!Number.isNaN(covered.getTime()) && (oldest === null || covered < oldest)) oldest = covered;
    for (const entry of account.days.values()) addInto(accountTotals, entry, addSplitCounts);
  }
  const coveredDay = oldest === null ? null : dateKey(oldest, 'UTC');

  const cursorTotals = new Map<string, DailyModelUsage>();
  const result: SourcedUsage[] = [];
  for (const machine of machines) {
    for (const entry of machine.usage) {
      if (entry.source === CURSOR_SOURCE && coveredDay !== null) addInto(cursorTotals, entry, addSplitCounts);
      else result.push(entry);
    }
  }

  // Cursor rows: the account figure alone before the covered day; from it on the larger of the two.
  const cursorRows = new Map<string, DailyModelUsage>();
  for (const [key, entry] of accountTotals) cursorRows.set(key, entry);
  for (const [key, entry] of cursorTotals) {
    if (entry.date < coveredDay!) continue;
    const account = cursorRows.get(key);
    cursorRows.set(key, account ? { ...account, counts: maxSplitCounts(account.counts, entry.counts) } : entry);
  }
  for (const entry of cursorRows.values()) result.push({ ...entry, source: CURSOR_SOURCE });
  return result;
}
