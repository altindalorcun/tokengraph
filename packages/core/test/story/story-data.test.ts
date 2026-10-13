import { describe, expect, it } from 'vitest';
import { FAMILY_RAMPS } from '../../src/index.js';
import type { ModelDayTotals } from '../../src/story/aggregate.js';
import type { CostRow } from '../../src/story/cost.js';
import { shiftDate } from '../../src/story/range.js';
import { buildStory, skylineWeeks, storyHighlight, type StoryInput } from '../../src/story/data.js';
import { demoStoryRows } from '../../src/story/demo.js';

// A Sunday, so the skyline's last week holds just this one day.
const TODAY = '2026-10-11';

function row(daysAgo: number, model: string, input: number, cacheRead = 0): ModelDayTotals {
  return { date: shiftDate(TODAY, -daysAgo), model, inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: cacheRead };
}

function costRow(r: ModelDayTotals): CostRow {
  return { ...r, pricingTier: 'standard', cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };
}

function story(rows: ModelDayTotals[], overrides: Partial<StoryInput> = {}) {
  return buildStory({ handle: 'octocat', range: 'today', todayUtc: TODAY, rows, costRows: rows.map(costRow), ...overrides });
}

describe('buildStory', () => {
  it('weighs each day and then sums the period, cache reads at a tenth', () => {
    const data = story([row(0, 'claude-sonnet-5', 1000, 10_000), row(1, 'claude-sonnet-5', 5)], { range: '7d' });
    expect(data.total).toBe(2000 + 5);
    expect(data.counts.cacheReadTokens).toBe(10_000);
    expect(data.startDate).toBe(shiftDate(TODAY, -6));
    expect(data.endDate).toBe(TODAY);
  });

  it('counts only the last day for today', () => {
    const data = story([row(0, 'claude-sonnet-5', 300), row(1, 'gpt-5.5', 900)]);
    expect(data.total).toBe(300);
    expect(data.models.map((m) => m.name)).toEqual(['Claude Sonnet 5']);
  });

  it('lists models heaviest first with shares, family and a dark-ramp shade by rank in family', () => {
    const data = story([row(0, 'claude-sonnet-5', 600), row(0, 'claude-haiku-4-5', 100), row(0, 'gpt-5.5', 300)]);
    expect(data.models.map((m) => [m.name, m.family, m.share])).toEqual([
      ['Claude Sonnet 5', 'claude', 0.6],
      ['gpt-5.5', 'gpt', 0.3],
      ['Claude Haiku 4.5', 'claude', 0.1],
    ]);
    expect(data.models[0]!.color).toBe(FAMILY_RAMPS.claude[5]);
    expect(data.models[1]!.color).toBe(FAMILY_RAMPS.gpt[5]);
    expect(data.models[2]!.color).toBe(FAMILY_RAMPS.claude[3]);
    expect(data.family).toBe('claude');
  });

  it('takes its accent from the family with the most tokens, not the single heaviest model', () => {
    const data = story([row(0, 'gpt-5.5', 400), row(0, 'claude-sonnet-5', 350), row(0, 'claude-haiku-4-5', 300)]);
    expect(data.family).toBe('claude');
  });

  it('prices the period, and gives no cost at all when nothing could be priced', () => {
    const priced = story([{ ...row(0, 'claude-sonnet-5', 1_000_000), outputTokens: 1_000_000 }]);
    expect(priced.cost).toEqual({ dollars: 12, complete: true });

    const unpriced = story([row(0, 'some-unknown-model', 1_000_000)]);
    expect(unpriced.cost).toBeNull();

    const partial = story([row(0, 'claude-sonnet-5', 1_000_000), row(0, 'some-unknown-model', 5)]);
    expect(partial.cost).toEqual({ dollars: 2, complete: false });
  });

  it('lays the skyline out in whole weeks, Sunday first, ending on the period, with future days empty', () => {
    const data = story([row(0, 'claude-sonnet-5', 10), row(3, 'claude-sonnet-5', 10)]);
    expect(data.weeks).toHaveLength(12);
    expect(data.weeks.every((week) => week.length === 7)).toBe(true);
    const last = data.weeks[11]!;
    expect(last[0]!.date).toBe(TODAY);
    expect(last.slice(1)).toEqual([null, null, null, null, null, null]);
    expect(data.weeks[0]![0]!.date).toBe(shiftDate(TODAY, -77));
  });

  it('marks only the period as lit and colours days by their own family', () => {
    const data = story([row(0, 'gpt-5.5', 10), row(3, 'claude-sonnet-5', 10)], { range: 'today' });
    const days = data.weeks.flat().filter((day) => day !== null);
    expect(days.filter((day) => day.inPeriod).map((day) => day.date)).toEqual([TODAY]);
    expect(days.find((day) => day.date === shiftDate(TODAY, -3))!.family).toBe('claude');
    expect(days.find((day) => day.date === shiftDate(TODAY, -1))).toMatchObject({ weighted: 0, level: 0, family: null });
  });

  it('shows the weeks since the first usage for twelve months, a quarter to a year', () => {
    expect(skylineWeeks('7d', TODAY, shiftDate(TODAY, -300))).toBe(12);
    expect(skylineWeeks('1y', TODAY, null)).toBe(53);
    expect(skylineWeeks('1y', TODAY, shiftDate(TODAY, -20))).toBe(12);
    // 140 days back from a Sunday is 20 whole weeks, plus the week the end day starts.
    expect(skylineWeeks('1y', TODAY, shiftDate(TODAY, -140))).toBe(21);
    expect(skylineWeeks('1y', TODAY, shiftDate(TODAY, -364))).toBe(53);
    expect(story([row(0, 'claude-sonnet-5', 1), row(200, 'claude-sonnet-5', 1)], { range: '1y' }).weeks).toHaveLength(30);
  });

  it('reports the streak, active days and the peak day of a longer period', () => {
    const data = story([row(0, 'claude-sonnet-5', 10), row(1, 'claude-sonnet-5', 50), row(2, 'claude-sonnet-5', 20), row(5, 'claude-sonnet-5', 5)], {
      range: '7d',
    });
    expect(data.streak).toBe(3);
    expect(data.activeDays).toBe(4);
    expect(data.peak).toEqual({ date: shiftDate(TODAY, -1), weighted: 50 });
    expect(story([row(0, 'claude-sonnet-5', 10)]).peak).toBeNull();
  });

  it('follows a client already into tomorrow, as the graph does', () => {
    const data = story([row(-1, 'claude-sonnet-5', 70), row(0, 'claude-sonnet-5', 30)]);
    expect(data.endDate).toBe(shiftDate(TODAY, 1));
    expect(data.total).toBe(70);
  });

  it('is an empty card, not an error, with no usage at all', () => {
    const data = story([]);
    expect(data).toMatchObject({ total: 0, models: [], family: 'other', cost: null, streak: 0, highlight: null });
  });
});

describe('storyHighlight', () => {
  const week = [10, 20, 30, 40, 50, 60, 70];

  it('calls a day above every earlier day a personal best', () => {
    expect(storyHighlight('today', 71, week, 1)).toEqual({ label: 'Personal best', kind: 'best' });
  });

  it('names a top-decile day by its rank', () => {
    const history = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(storyHighlight('today', 96, history, 1)).toEqual({ label: 'Top 5% day', kind: 'top' });
    expect(storyHighlight('today', 50, history, 1)).toBeNull();
  });

  it('needs a week of history before it calls anything a record', () => {
    expect(storyHighlight('today', 999, [1, 2, 3], 1)).toBeNull();
  });

  it('falls back to a streak of a week or more', () => {
    expect(storyHighlight('7d', 500, week, 9)).toEqual({ label: '9-day streak', kind: 'streak' });
    expect(storyHighlight('7d', 500, week, 6)).toBeNull();
  });
});

describe('demoStoryRows', () => {
  it('always has usage today and nothing after it', () => {
    for (const date of ['2026-10-11T12:00:00Z', '2026-03-02T08:00:00Z', '2025-12-31T23:00:00Z']) {
      const { rows, todayUtc } = demoStoryRows(new Date(date));
      expect(rows.some((r) => r.date === todayUtc)).toBe(true);
      expect(rows.every((r) => r.date <= todayUtc)).toBe(true);
    }
  });
});
