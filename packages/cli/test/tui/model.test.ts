import { describe, expect, it } from 'vitest';
import { cacheSavingsForSplitCounts } from '@tokengraph/core';
import { emptyLedger, mergeUsage, type Ledger } from '../../src/ledger.js';
import {
  agentBreakdown, agentBuckets, buildViewModel, familyBuckets, monthlyTotals, rangeBuckets, dailySeries, familySeries, formatCost, insights, modelBreakdown, rangeStart, rangeTotals,
  shiftDate, stats, yearGrid,
} from '../../src/tui/model.js';

const TODAY = '2026-10-03';

function counts(input: number, output = 0, cacheRead = 0, split: number | null = 0) {
  return {
    inputTokens: input, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: cacheRead,
    cacheCreation5mTokens: split, cacheCreation1hTokens: split,
  };
}

function ledgerWith(rows: { source: 'claude-code' | 'codex-cli'; date: string; model: string; c: ReturnType<typeof counts> }[]): Ledger {
  let ledger = emptyLedger();
  for (const row of rows) {
    ledger = mergeUsage(ledger, row.source, [{ date: row.date, model: row.model, pricingTier: 'standard', counts: row.c }]);
  }
  return ledger;
}

describe('view model', () => {
  it('handles an empty ledger without NaN', () => {
    const vm = buildViewModel(emptyLedger(), TODAY);
    expect(vm.days).toEqual([]);
    expect(stats(vm)).toEqual({ today: 0, week: 0, weekDelta: null, streak: 0, longest: null });
    const totals = rangeTotals(vm, '30d');
    expect(totals.cost.cacheSaved).toBe(0);
    expect(formatCost(totals.cost)).toBe('$0.00');
    expect(modelBreakdown(vm, 'all')).toEqual([]);
    expect(insights(vm).novels).toBe(0);
    expect(yearGrid(vm, TODAY).columns).toHaveLength(52);
  });

  it('sums per day before weighting and picks the top family', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'claude-code', date: TODAY, model: 'claude-opus-4-1-20250805', c: counts(100, 0, 15) },
        { source: 'codex-cli', date: TODAY, model: 'gpt-5', c: counts(50, 0, 15) },
      ]),
      TODAY,
    );
    const day = vm.byDate.get(TODAY)!;
    expect(day.weighted).toBe(153); // 150 + 0.1 × 30, not 101.5 + 51.5 rounded separately
    expect(day.topFamily).toBe('claude');
    expect(day.models.map((m) => m.key)).toEqual(['claude-opus-4-1', 'gpt-5']);
    expect(day.agents.map((a) => a.name)).toEqual(['Claude Code', 'Codex CLI']);
  });

  it('splits each day by model family, oldest first, with empty days empty', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'claude-code', date: TODAY, model: 'claude-opus-4-1-20250805', c: counts(100, 0, 15) },
        { source: 'codex-cli', date: TODAY, model: 'gpt-5', c: counts(50, 0, 15) },
      ]),
      TODAY,
    );
    const series = familySeries(vm, TODAY, 3);
    expect(series.map((d) => d.date)).toEqual([shiftDate(TODAY, -2), shiftDate(TODAY, -1), TODAY]);
    expect(series[0]).toEqual({ date: shiftDate(TODAY, -2), weighted: 0, families: [] });
    const last = series[2]!;
    expect(last.families.map((f) => f.family)).toEqual(['claude', 'gpt']);
    // 101.5 and 51.5, each rounded by weightedTokens like DayRow.models; the day rounds 153 once
    expect(last.families[0]!.weighted).toBe(102);
    expect(last.families[1]!.weighted).toBe(52);
    const sum = last.families.reduce((a, f) => a + f.weighted, 0);
    expect(Math.abs(sum - last.weighted)).toBeLessThanOrEqual(1);
  });

  it('puts unknown models into the other family', () => {
    const vm = buildViewModel(ledgerWith([{ source: 'codex-cli', date: TODAY, model: 'mystery-model-9', c: counts(200) }]), TODAY);
    const [day] = familySeries(vm, TODAY, 1);
    expect(day!.families).toEqual([{ family: 'other', weighted: 200 }]);
  });

  it('computes streaks the way the web does', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: shiftDate(TODAY, -1), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -2), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -10), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -11), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -12), model: 'gpt-5', c: counts(10) },
      ]),
      TODAY,
    );
    const s = stats(vm);
    expect(s.streak).toBe(2); // a quiet today does not break it
    expect(s.longest).toEqual({ length: 3, start: shiftDate(TODAY, -12), end: shiftDate(TODAY, -10) });
    expect(s.week).toBe(20);
  });

  it('never shows unpriced as $0', () => {
    const vm = buildViewModel(
      ledgerWith([{ source: 'codex-cli', date: TODAY, model: 'mystery-model-9000', c: counts(1000) }]),
      TODAY,
    );
    expect(formatCost(rangeTotals(vm, '7d').cost)).toBe('cost unknown');
  });

  it('marks partly unpriced ranges', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: TODAY, model: 'gpt-5.5', c: counts(1_000_000) }, // priced (pricing.ts)
        { source: 'codex-cli', date: TODAY, model: 'mystery-model-9000', c: counts(1000) },
      ]),
      TODAY,
    );
    expect(formatCost(rangeTotals(vm, '7d').cost)).toMatch(/^≈ \$\d[\d,]*\.\d\d \+ unpriced$/);
  });

  it('filters ranges and builds breakdowns with shares and 30-day series', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: TODAY, model: 'gpt-5', c: counts(300) },
        { source: 'claude-code', date: shiftDate(TODAY, -3), model: 'claude-sonnet-4-5', c: counts(100) },
        { source: 'claude-code', date: shiftDate(TODAY, -40), model: 'claude-sonnet-4-5', c: counts(1000) },
      ]),
      TODAY,
    );
    expect(rangeStart('7d', TODAY)).toBe(shiftDate(TODAY, -6));
    expect(rangeStart('all', TODAY)).toBeNull();
    const models = modelBreakdown(vm, '7d');
    expect(models.map((m) => [m.key, m.share])).toEqual([['gpt-5', 0.75], ['claude-sonnet-4-5', 0.25]]);
    const agents = agentBreakdown(vm, 'all');
    expect(agents[0]!.key).toBe('claude-code');
    expect(agents[0]!.daily30).toHaveLength(30);
    expect(agents[0]!.daily30[26]).toBe(100);
    expect(agents[0]!.lastActive).toBe(shiftDate(TODAY, -3));
    expect(dailySeries(vm, TODAY, 5)).toEqual([0, 100, 0, 0, 300]);
    expect(rangeTotals(vm, '30d').activeDays).toBe(2);
  });

  it('shows Claude models by display name and keeps the label as key', () => {
    const vm = buildViewModel(
      ledgerWith([{ source: 'claude-code', date: TODAY, model: 'claude-sonnet-4-5', c: counts(100) }]),
      TODAY,
    );
    const first = modelBreakdown(vm, '30d')[0]!;
    expect(first.key).toBe('claude-sonnet-4-5');
    expect(first.name).toBe('Claude Sonnet 4.5');
    expect(insights(vm).favourite.name).toBe('Claude Sonnet 4.5');
  });

  it('builds insights', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: '2026-09-28', model: 'gpt-5', c: counts(10, 240_000) }, // a Monday
        { source: 'codex-cli', date: '2026-09-29', model: 'gpt-5', c: counts(10) },
      ]),
      TODAY,
    );
    const i = insights(vm);
    expect(i.record).toEqual({ date: '2026-09-28', weighted: 240_010 });
    expect(i.favourite?.name).toBe('gpt-5');
    expect(i.outputTokens).toBe(240_000);
    expect(i.novels).toBe(2);
    expect(i.weekdays).toHaveLength(7);
    expect(i.weekdays[0]).toBeCloseTo(240_010 / 52);
    expect(i.firstDay).toBe('2026-09-28');
    expect(i.activeDays).toBe(2);
  });

  it('adds up what caching saved over priced rows only', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'claude-code', date: TODAY, model: 'claude-sonnet-4-5', c: counts(100, 0, 300_000) },
        { source: 'codex-cli', date: TODAY, model: 'mystery-model-9', c: counts(100, 0, 900_000) },
      ]),
      TODAY,
    );
    const expected = cacheSavingsForSplitCounts('claude-sonnet-4-5', TODAY, counts(100, 0, 300_000))!;
    expect(expected).toBeGreaterThan(0);
    expect(rangeTotals(vm, '7d').cost.cacheSaved).toBeCloseTo(expected);
    expect(vm.byDate.get(TODAY)!.cost.cacheSaved).toBeCloseTo(expected);
  });

  it('ignores days after today in ranges and stats but keeps them in days', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: shiftDate(TODAY, 2), model: 'gpt-5', c: counts(500) },
        { source: 'codex-cli', date: TODAY, model: 'gpt-5', c: counts(10) },
      ]),
      TODAY,
    );
    expect(vm.days).toHaveLength(2);
    expect(rangeTotals(vm, 'all').weighted).toBe(10);
    expect(stats(vm).week).toBe(10);
    expect(insights(vm).record).toEqual({ date: TODAY, weighted: 10 });
  });

  it('breaks family and streak ties deterministically', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: shiftDate(TODAY, -5), model: 'gpt-5', c: counts(100) },
        { source: 'claude-code', date: shiftDate(TODAY, -5), model: 'claude-sonnet-4-5', c: counts(100) },
        { source: 'codex-cli', date: shiftDate(TODAY, -3), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -2), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -8), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -7), model: 'gpt-5', c: counts(10) },
      ]),
      TODAY,
    );
    expect(vm.byDate.get(shiftDate(TODAY, -5))!.topFamily).toBe('claude'); // MODEL_FAMILIES order
    expect(stats(vm).longest).toEqual({ length: 2, start: shiftDate(TODAY, -3), end: shiftDate(TODAY, -2) });
  });

  it('keeps daily30 a fixed 30-day window whatever the range', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: TODAY, model: 'gpt-5', c: counts(300) },
        { source: 'codex-cli', date: shiftDate(TODAY, -20), model: 'gpt-5', c: counts(70) },
        { source: 'codex-cli', date: shiftDate(TODAY, 1), model: 'gpt-5', c: counts(999) },
      ]),
      TODAY,
    );
    for (const row of [modelBreakdown(vm, '7d')[0]!, agentBreakdown(vm, '7d')[0]!]) {
      expect(row.daily30).toHaveLength(30);
      expect(row.daily30[29]).toBe(300);
      expect(row.daily30[9]).toBe(70); // today - 20, outside the 7-day range
      expect(row.weighted).toBe(300); // the row itself still follows the range
    }
  });

  it('includes the first day of a range and excludes the day before it', () => {
    const vm = buildViewModel(
      ledgerWith([
        { source: 'codex-cli', date: shiftDate(TODAY, -6), model: 'gpt-5', c: counts(10) },
        { source: 'codex-cli', date: shiftDate(TODAY, -7), model: 'gpt-5', c: counts(1000) },
      ]),
      TODAY,
    );
    const totals = rangeTotals(vm, '7d');
    expect(totals.weighted).toBe(10);
    expect(totals.activeDays).toBe(1);
  });

  it('prices a gpt-5.5 row from the published rate', () => {
    const vm = buildViewModel(
      ledgerWith([{ source: 'codex-cli', date: TODAY, model: 'gpt-5.5', c: counts(1_000_000, 100_000) }]),
      TODAY,
    );
    const dollars = (1_000_000 * 5) / 1e6 + (100_000 * 30) / 1e6; // $5 / $30 per million in pricing.ts
    expect(dollars).toBe(8);
    expect(formatCost(rangeTotals(vm, '7d').cost)).toBe('≈ $8.00');
  });

  it('treats a Claude row with an unknown cache-write split as unpriced', () => {
    const c = { ...counts(1000), cacheCreationTokens: 500, cacheCreation5mTokens: null, cacheCreation1hTokens: null };
    const vm = buildViewModel(
      ledgerWith([{ source: 'claude-code', date: TODAY, model: 'claude-sonnet-4-5', c }]),
      TODAY,
    );
    expect(formatCost(rangeTotals(vm, '7d').cost)).toBe('cost unknown');
  });
});

describe('chart buckets', () => {
  const row = (source: 'claude-code' | 'codex-cli', date: string, model: string, input: number) => ({ source, date, model, c: counts(input) });

  it('builds day, week and month buckets', () => {
    const vm = buildViewModel(ledgerWith([row('claude-code', '2026-03-15', 'claude-opus-4-1-20250805', 10)]), TODAY);
    const week = rangeBuckets(vm, '7d');
    expect(week).toHaveLength(7);
    expect(week[0]).toEqual({ label: '27 Sep', start: '2026-09-27', end: '2026-09-27' });
    expect(week[6]).toEqual({ label: '3 Oct', start: TODAY, end: TODAY });
    expect(rangeBuckets(vm, '30d')).toHaveLength(30);
    expect(rangeBuckets(vm, '90d')).toHaveLength(90);
    const weeks = rangeBuckets(vm, '1y');
    expect(weeks).toHaveLength(52);
    expect(weeks[51]).toEqual({ label: '27 Sep', start: '2026-09-27', end: TODAY });
    expect(weeks[50]!.end).toBe('2026-09-26');
    expect(weeks[0]!.start).toBe(shiftDate(TODAY, -363)); // 52 whole weeks
    const months = rangeBuckets(vm, 'all');
    expect(months.map((m) => m.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(months[0]).toMatchObject({ start: '2026-03-01', end: '2026-03-31' });
    expect(months[7]).toMatchObject({ start: '2026-10-01', end: TODAY });
  });

  it('labels other years, caps months at 36 and keeps one for an empty ledger', () => {
    const old = buildViewModel(ledgerWith([row('claude-code', '2020-01-05', 'gpt-5', 10)]), TODAY);
    const months = rangeBuckets(old, 'all');
    expect(months).toHaveLength(36);
    expect(months[0]).toMatchObject({ label: 'Nov 23', start: '2023-11-01' });
    expect(months[35]!.label).toBe('Oct');
    expect(rangeBuckets(buildViewModel(emptyLedger(), TODAY), 'all')).toHaveLength(1);
  });

  it('counts a day on a bucket start and end but not the day before the start', () => {
    const vm = buildViewModel(
      ledgerWith([
        row('claude-code', '2026-09-26', 'claude-opus-4-1-20250805', 1000),
        row('claude-code', '2026-09-27', 'claude-opus-4-1-20250805', 100),
        row('codex-cli', TODAY, 'gpt-5', 10),
      ]),
      TODAY,
    );
    const last = familyBuckets(vm, rangeBuckets(vm, '1y')).at(-1)!;
    expect(last.weighted).toBe(110);
    expect(last.families).toEqual([{ family: 'claude', weighted: 100 }, { family: 'gpt', weighted: 10 }]);
    const previous = familyBuckets(vm, rangeBuckets(vm, '1y')).at(-2)!;
    expect(previous.weighted).toBe(1000);
  });

  it('splits buckets by agent, biggest source first, and skips future days', () => {
    const vm = buildViewModel(
      ledgerWith([
        row('claude-code', '2026-10-02', 'claude-opus-4-1-20250805', 5),
        row('codex-cli', '2026-10-02', 'gpt-5', 50),
        row('codex-cli', '2026-10-09', 'gpt-5', 999),
      ]),
      TODAY,
    );
    const month = agentBuckets(vm, rangeBuckets(vm, 'all')).at(-1)!;
    expect(month.agents.map((a) => a.source)).toEqual(['codex-cli', 'claude-code']);
    expect(month.weighted).toBe(55);
    expect(agentBuckets(vm, rangeBuckets(vm, '7d'))[5]!.agents.map((a) => a.weighted)).toEqual([50, 5]);
  });

  it('totals the 12 months ending with this month', () => {
    const vm = buildViewModel(
      ledgerWith([
        row('claude-code', '2025-09-30', 'gpt-5', 7),
        row('claude-code', '2025-10-01', 'gpt-5', 3),
        row('claude-code', '2026-10-03', 'gpt-5', 4),
        row('claude-code', '2026-10-20', 'gpt-5', 400),
      ]),
      TODAY,
    );
    const months = monthlyTotals(vm);
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ label: 'Nov', weighted: 0 });
    expect(months[11]).toEqual({ label: 'Oct', weighted: 4 });
    expect(months[10]!.label).toBe('Sep');
    expect(months.reduce((a, m) => a + m.weighted, 0)).toBe(4);
  });
});
