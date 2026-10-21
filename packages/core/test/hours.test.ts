import { describe, expect, it } from 'vitest';
import { combineMachineHours, HourSums, type MachineHours } from '../src/hours.js';

const UTC = 'UTC';

describe('HourSums', () => {
  it('sums per date and hour, sorted, and ignores empty or invalid cells', () => {
    const sums = new HourSums();
    sums.add('2026-10-02', 5, 10);
    sums.add('2026-10-01', 23, 4);
    sums.add('2026-10-02', 5, 6);
    sums.add('2026-10-02', 24, 9);
    sums.add('2026-10-02', 6, 0);
    expect(sums.toList()).toEqual([
      { date: '2026-10-01', hour: 23, weighted: 4 },
      { date: '2026-10-02', hour: 5, weighted: 16 },
    ]);
  });
});

describe('combineMachineHours', () => {
  const machine = (sources: MachineHours['sources'], accounts: MachineHours['accounts'] = {}): MachineHours => ({ sources, accounts });
  const cursorRows = (rows: ReturnType<typeof combineMachineHours>) => rows.filter((r) => r.source === 'cursor').map((r) => `${r.date} ${r.hour} ${r.weighted}`);

  it('leaves every source alone without an account', () => {
    const rows = combineMachineHours(machine({ cursor: { '2026-10-01': { '9': 5 } }, 'claude-code': { '2026-10-01': { '9': 7 } } }), UTC);
    expect(rows.map((r) => `${r.source} ${r.hour} ${r.weighted}`)).toEqual(['claude-code 9 7', 'cursor 9 5']);
  });

  it('uses account hours on covered days, hook hours after, and the per-hour max on the boundary day', () => {
    const rows = combineMachineHours(
      machine(
        {
          cursor: {
            '2026-10-01': { '9': 100 }, // covered: ignored, the account is complete
            '2026-10-02': { '10': 30, '11': 5 }, // boundary day
            '2026-10-03': { '8': 40 }, // after the account: hook only
          },
        },
        { aaaaaaaaaaaaaaaa: { coveredThrough: '2026-10-02T12:00:00Z', hours: { '2026-10-01': { '9': 20, '14': 3 }, '2026-10-02': { '10': 10, '11': 25 } } } },
      ),
      UTC,
    );
    expect(cursorRows(rows)).toEqual([
      '2026-10-01 9 20',
      '2026-10-01 14 3',
      '2026-10-02 10 30',
      '2026-10-02 11 25',
      '2026-10-03 8 40',
    ]);
  });

  it('sums different accounts and leaves other agents out of the Cursor rule', () => {
    const rows = combineMachineHours(
      machine(
        { 'codex-cli': { '2026-10-01': { '3': 9 } } },
        {
          aaaaaaaaaaaaaaaa: { coveredThrough: '2026-10-05T00:00:00Z', hours: { '2026-10-01': { '9': 2 } } },
          bbbbbbbbbbbbbbbb: { coveredThrough: '2026-10-04T00:00:00Z', hours: { '2026-10-01': { '9': 3 } } },
        },
      ),
      UTC,
    );
    expect(rows.map((r) => `${r.source} ${r.hour} ${r.weighted}`)).toEqual(['codex-cli 3 9', 'cursor 9 5']);
  });
});
