import { describe, expect, it } from 'vitest';
import { combineMachineUsage, type AccountUsage, type MachineUsage, type SourcedUsage } from '../src/combine-usage.js';
import type { DailyModelUsage } from '../src/types.js';

const counts = (input: number, output = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  cacheCreation5mTokens: null,
  cacheCreation1hTokens: null,
});
const day = (date: string, model: string, input: number, output = 0): DailyModelUsage => ({ date, model, pricingTier: 'standard', counts: counts(input, output) });
const local = (source: SourcedUsage['source'], date: string, model: string, input: number): SourcedUsage => ({ source, ...day(date, model, input) });
const account = (coveredThrough: string, ...usage: DailyModelUsage[]): AccountUsage => ({ coveredThrough, usage });
const machine = (usage: SourcedUsage[], accounts: Record<string, AccountUsage> = {}): MachineUsage => ({ usage, accounts });

/** Totals per source, date and model, summed the way every consumer sums the rows. */
function totals(rows: readonly SourcedUsage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.source} ${row.date} ${row.model}`;
    out[key] = (out[key] ?? 0) + row.counts.inputTokens;
  }
  return out;
}

const UTC = 'UTC';

describe('combineMachineUsage', () => {
  it('sums agents across machines and leaves them alone without an account', () => {
    const rows = combineMachineUsage(
      [
        machine([local('claude-code', '2026-10-01', 'm', 5), local('cursor', '2026-10-01', 'c', 7)]),
        machine([local('claude-code', '2026-10-01', 'm', 3), local('cursor', '2026-10-01', 'c', 2)]),
      ],
      UTC,
    );
    expect(totals(rows)).toEqual({ 'claude-code 2026-10-01 m': 8, 'cursor 2026-10-01 c': 9 });
  });

  it('counts one account fetched on two machines once (per-field max), and two accounts together', () => {
    const a1 = account('2026-10-10T12:00:00.000Z', day('2026-10-09', 'c', 100, 10));
    const a2 = account('2026-10-10T18:00:00.000Z', day('2026-10-09', 'c', 120, 5));
    const b = account('2026-10-10T09:00:00.000Z', day('2026-10-09', 'c', 40));
    const rows = combineMachineUsage([machine([], { aaaa: a1, bbbb: b }), machine([], { aaaa: a2 })], UTC);
    // account aaaa: max(100,120)=120 input and max(10,5)=10 output; account bbbb: 40.
    expect(totals(rows)).toEqual({ 'cursor 2026-10-09 c': 160 });
    expect(rows.reduce((sum, row) => sum + row.counts.outputTokens, 0)).toBe(10);
  });

  it('ignores the cursor source on days before the newest coveredThrough', () => {
    const rows = combineMachineUsage(
      [
        machine([local('cursor', '2026-10-08', 'c', 999), local('cursor', '2026-10-09', 'c', 999)], { aaaa: account('2026-10-10T12:00:00.000Z', day('2026-10-08', 'c', 50), day('2026-10-09', 'c', 60)) }),
        machine([local('cursor', '2026-10-08', 'c', 999)]),
      ],
      UTC,
    );
    expect(totals(rows)).toEqual({ 'cursor 2026-10-08 c': 50, 'cursor 2026-10-09 c': 60 });
  });

  it('on the covered day and later takes, per model, the larger of account and the summed cursor source', () => {
    const rows = combineMachineUsage(
      [
        machine(
          [
            local('cursor', '2026-10-10', 'big-hooks', 500),
            local('cursor', '2026-10-10', 'big-account', 10),
            local('cursor', '2026-10-11', 'later', 30),
            local('cursor', '2026-10-10', 'hook-only', 8),
          ],
          { aaaa: account('2026-10-10T12:00:00.000Z', day('2026-10-10', 'big-hooks', 100), day('2026-10-10', 'big-account', 200)) },
        ),
        // A second machine's hook events for the same day add to the first machine's before the comparison.
        machine([local('cursor', '2026-10-10', 'big-account', 15)]),
      ],
      UTC,
    );
    expect(totals(rows)).toEqual({
      'cursor 2026-10-10 big-hooks': 500,
      'cursor 2026-10-10 big-account': 200,
      'cursor 2026-10-10 hook-only': 8,
      'cursor 2026-10-11 later': 30,
    });
  });

  it('keeps the account on the boundary day when there is no hook data', () => {
    const rows = combineMachineUsage([machine([], { aaaa: account('2026-10-10T23:59:00.000Z', day('2026-10-10', 'c', 70)) })], UTC);
    expect(totals(rows)).toEqual({ 'cursor 2026-10-10 c': 70 });
  });

  it('uses the newest coveredThrough of any account, from any machine', () => {
    const rows = combineMachineUsage(
      [
        machine([local('cursor', '2026-10-09', 'c', 999)], { aaaa: account('2026-10-08T10:00:00.000Z', day('2026-10-08', 'c', 1)) }),
        machine([], { bbbb: account('2026-10-10T10:00:00.000Z', day('2026-10-10', 'c', 2)) }),
      ],
      UTC,
    );
    // The 9th is before the 10th (newest), so the hook rows are dropped there.
    expect(totals(rows)).toEqual({ 'cursor 2026-10-08 c': 1, 'cursor 2026-10-10 c': 2 });
  });

  it('works with an account present on only one machine', () => {
    const rows = combineMachineUsage(
      [machine([local('claude-code', '2026-10-01', 'm', 4)], { aaaa: account('2026-10-02T00:00:00.000Z', day('2026-10-01', 'c', 9)) }), machine([local('claude-code', '2026-10-01', 'm', 1)])],
      UTC,
    );
    expect(totals(rows)).toEqual({ 'claude-code 2026-10-01 m': 5, 'cursor 2026-10-01 c': 9 });
  });

  it('keys the day by the given time zone', () => {
    const covered = account('2026-10-10T20:00:00.000Z');
    const hooks = machine([local('cursor', '2026-10-10', 'c', 5), local('cursor', '2026-10-11', 'c', 6)], { aaaa: covered });
    // In UTC the covered day is the 10th (hooks kept from the 10th); at +10 hours it is already the 11th.
    expect(totals(combineMachineUsage([hooks], 'UTC'))).toEqual({ 'cursor 2026-10-10 c': 5, 'cursor 2026-10-11 c': 6 });
    expect(totals(combineMachineUsage([hooks], 'Pacific/Port_Moresby'))).toEqual({ 'cursor 2026-10-11 c': 6 });
  });

  it('keeps an unknown cache split unknown', () => {
    const rows = combineMachineUsage([machine([], { aaaa: account('2026-10-10T00:00:00.000Z', day('2026-10-09', 'c', 1)) })], UTC);
    expect(rows[0]!.counts.cacheCreation5mTokens).toBeNull();
  });
});
