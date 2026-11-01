import { describe, expect, it } from 'vitest';
import type { KnownSource, ProjectUsage } from '@tokengraph/core';
import { emptyLedger, mergeCursorAccount, mergeProjectRoots, mergeProjects, mergeUsage, type Ledger } from '../src/ledger.js';
import {
  cleanProjectName,
  NOT_ASSIGNED,
  projectDisplayNames,
  projectRows,
  summariseProjects,
  topProjects,
} from '../src/project-usage.js';
import { buildViewModel, RANGES, rangeTotals } from '../src/tui/model.js';

const HOME = '/Users/me';
const TODAY = '2026-11-01';
const counts = (inputTokens: number, outputTokens = 0, cacheReadTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheCreationTokens: 0,
  cacheReadTokens,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
});
const usage = (date: string, c: ReturnType<typeof counts>, model = 'claude-opus-4-8') => ({ date, model, pricingTier: 'standard' as const, counts: c });
const folder = (name: string, date: string, c: ReturnType<typeof counts>, model = 'claude-opus-4-8'): ProjectUsage => ({ ...usage(date, c, model), folder: name });

function ledgerWith(source: KnownSource, totals: ReturnType<typeof usage>[], folders: ProjectUsage[], roots: Record<string, string> = {}, base: Ledger = emptyLedger()): Ledger {
  return mergeProjectRoots(mergeProjects(mergeUsage(base, source, totals), source, folders), roots);
}

describe('projectDisplayNames', () => {
  const names = (roots: string[], user: Record<string, string> = {}) => Object.fromEntries(projectDisplayNames(roots, user, HOME));

  it('defaults to the folder name', () => {
    expect(names([`${HOME}/code/app`])).toEqual({ [`${HOME}/code/app`]: 'app' });
  });

  it('adds the parent when two roots share a name', () => {
    expect(names([`${HOME}/a/cli`, `${HOME}/b/cli`])).toEqual({ [`${HOME}/a/cli`]: 'a/cli', [`${HOME}/b/cli`]: 'b/cli' });
  });

  it('never falls back to a full path, which would put a user name in an export', () => {
    const shown = names(['C:/Users/alice/work/acme', 'D:/Users/alice/work/acme']);
    expect(Object.values(shown)).toHaveLength(2);
    expect(new Set(Object.values(shown)).size).toBe(2);
    for (const name of Object.values(shown)) {
      expect(name).toMatch(/^acme-[0-9a-f]{4}$/);
      expect(name).not.toContain('alice');
    }
  });

  it('calls the home folder and the disk root Home folder', () => {
    expect(names([HOME, '/'])).toEqual({ [HOME]: 'Home folder', '/': 'Home folder' });
  });

  it('lets a name set by the user win', () => {
    expect(names([`${HOME}/a/cli`], { [`${HOME}/a/cli`]: 'tokengraph' })).toEqual({ [`${HOME}/a/cli`]: 'tokengraph' });
  });

  it('never lets a folder pose as the Not assigned row', () => {
    expect(names([`${HOME}/a/${NOT_ASSIGNED}`])[`${HOME}/a/${NOT_ASSIGNED}`]).not.toBe(NOT_ASSIGNED);
  });

  it('strips control characters from a folder name', () => {
    expect(names([`${HOME}/a\x1b[31mb\x07`])[`${HOME}/a\x1b[31mb\x07`]).toBe('a[31mb');
  });
});

describe('cleanProjectName', () => {
  it('strips escape sequences and trims', () => {
    expect(cleanProjectName('  a\x1b[31mb\x07 ')).toBe('a[31mb');
  });

  it('caps the length', () => {
    expect(cleanProjectName('x'.repeat(200))).toHaveLength(60);
  });
});

describe('projectRows and summariseProjects', () => {
  it('sums the roots that share a name into one project', () => {
    const a = `${HOME}/code/cli`;
    const b = `${HOME}/code/site`;
    const ledger = ledgerWith('claude-code', [usage('2026-10-30', counts(300))], [folder(a, '2026-10-30', counts(100)), folder(b, '2026-10-30', counts(200))]);
    const rows = projectRows(ledger, { [a]: 'tokengraph', [b]: 'tokengraph' }, HOME);
    const [project, ...rest] = summariseProjects(rows, '30d', TODAY);
    expect(project).toMatchObject({ name: 'tokengraph', weighted: 300, assigned: true, folders: [a, b] });
    expect(rest).toEqual([]);
  });

  it('groups a subfolder under its root', () => {
    const repo = `${HOME}/code/app`;
    const ledger = ledgerWith('claude-code', [usage('2026-10-30', counts(30))], [folder(`${repo}/src`, '2026-10-30', counts(10)), folder(repo, '2026-10-30', counts(20))], { [`${repo}/src`]: repo, [repo]: repo });
    expect(summariseProjects(projectRows(ledger, {}, HOME), '30d', TODAY)).toMatchObject([{ name: 'app', weighted: 30, folders: [repo] }]);
  });

  it('puts usage with no folder in Not assigned, last, whatever its size', () => {
    const ledger = ledgerWith('claude-code', [usage('2026-10-30', counts(1000))], [folder(`${HOME}/app`, '2026-10-30', counts(100))]);
    const summaries = summariseProjects(projectRows(ledger, {}, HOME), '30d', TODAY);
    expect(summaries.map((s) => [s.name, s.weighted, s.assigned])).toEqual([['app', 100, true], [NOT_ASSIGNED, 900, false]]);
    expect(summaries[0]!.share).toBeCloseTo(0.1);
  });

  it('shows everything as Not assigned for a ledger with no project data', () => {
    const summaries = summariseProjects(projectRows(mergeUsage(emptyLedger(), 'codex-cli', [usage('2026-10-30', counts(5))]), {}, HOME), '30d', TODAY);
    expect(summaries.map((s) => s.name)).toEqual([NOT_ASSIGNED]);
  });

  it('splits a project by model and agent with tokens, share and cost', () => {
    const a = `${HOME}/app`;
    let ledger = ledgerWith('claude-code', [usage('2026-10-30', counts(1_000_000))], [folder(a, '2026-10-30', counts(1_000_000))]);
    ledger = ledgerWith('codex-cli', [usage('2026-10-30', counts(3_000_000), 'gpt-5.5')], [folder(a, '2026-10-30', counts(3_000_000), 'gpt-5.5')], {}, ledger);
    const [project] = summariseProjects(projectRows(ledger, {}, HOME), '30d', TODAY);
    expect(project!.agents.map((s) => [s.key, s.weighted, s.share])).toEqual([['codex-cli', 3_000_000, 0.75], ['claude-code', 1_000_000, 0.25]]);
    expect(project!.models).toHaveLength(2);
    expect(project!.models[0]!.cost.dollars + project!.models[1]!.cost.dollars).toBeCloseTo(project!.cost.dollars);
    expect(project!.cost.dollars).toBeGreaterThan(0);
  });

  it('keeps an unpriced model unpriced, never $0', () => {
    const ledger = ledgerWith('opencode', [usage('2026-10-30', counts(500), 'some-open-model')], [folder(`${HOME}/app`, '2026-10-30', counts(500), 'some-open-model')]);
    const [project] = summariseProjects(projectRows(ledger, {}, HOME), '30d', TODAY);
    expect(project!.cost).toMatchObject({ dollars: 0, pricedWeighted: 0, unpricedWeighted: 500 });
  });

  it('leaves a project out of a range it was not active in, and draws its 30-day series from today back', () => {
    const ledger = ledgerWith('claude-code', [usage('2026-10-30', counts(5)), usage('2026-06-01', counts(9))], [folder(`${HOME}/new`, '2026-10-30', counts(5)), folder(`${HOME}/old`, '2026-06-01', counts(9))]);
    const rows = projectRows(ledger, {}, HOME);
    expect(summariseProjects(rows, '30d', TODAY).map((s) => s.name)).toEqual(['new']);
    expect(summariseProjects(rows, 'all', TODAY).map((s) => s.name)).toEqual(['old', 'new']);
    const [recent] = summariseProjects(rows, '30d', TODAY);
    expect(recent!.daily30).toHaveLength(30);
    expect(recent!.daily30[27]).toBe(5);
    expect(recent!.lastActive).toBe('2026-10-30');
  });

  it('a Not assigned row with an unknowable cache split carries null, not 0', () => {
    const total = { ...counts(100), cacheCreation5mTokens: null, cacheCreation1hTokens: null };
    const ledger = ledgerWith('claude-code', [usage('2026-10-30', total)], [folder(`${HOME}/app`, '2026-10-30', counts(10))]);
    const rest = projectRows(ledger, {}, HOME).find((row) => row.project === NOT_ASSIGNED)!;
    expect(rest.counts).toMatchObject({ inputTokens: 90, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
  });
});

describe('project rows plus Not assigned equal the view total', () => {
  const sumRange = (ledger: Ledger, range: (typeof RANGES)[number]) => {
    const summaries = summariseProjects(projectRows(ledger, {}, HOME), range, TODAY);
    return {
      weighted: summaries.reduce((sum, s) => sum + s.weighted, 0),
      input: summaries.reduce((sum, s) => sum + s.counts.inputTokens, 0),
      output: summaries.reduce((sum, s) => sum + s.counts.outputTokens, 0),
      cacheRead: summaries.reduce((sum, s) => sum + s.counts.cacheReadTokens, 0),
      dollars: summaries.reduce((sum, s) => sum + s.cost.dollars, 0),
    };
  };
  const expectEqual = (ledger: Ledger) => {
    const vm = buildViewModel(ledger, TODAY);
    for (const range of RANGES) {
      const totals = rangeTotals(vm, range);
      const sums = sumRange(ledger, range);
      expect(sums.weighted, range).toBeCloseTo(totals.weighted, 3);
      expect(sums.input, range).toBe(totals.counts.inputTokens);
      expect(sums.output, range).toBe(totals.counts.outputTokens);
      expect(sums.cacheRead, range).toBe(totals.counts.cacheReadTokens);
      expect(sums.dollars, range).toBeCloseTo(totals.cost.dollars, 6);
    }
  };

  const mixed = (): Ledger => {
    let ledger = ledgerWith(
      'claude-code',
      [usage('2026-10-30', counts(1000, 50, 700)), usage('2026-10-01', counts(400, 10)), usage('2026-05-01', counts(90))],
      [folder(`${HOME}/a`, '2026-10-30', counts(600, 20, 300)), folder(`${HOME}/b`, '2026-10-30', counts(100, 5, 100)), folder(`${HOME}/a`, '2026-10-01', counts(400, 10))],
    );
    ledger = ledgerWith('codex-cli', [usage('2026-10-29', counts(70, 3), 'gpt-5.5')], [folder(`${HOME}/c`, '2026-10-29', counts(70, 3), 'gpt-5.5')], {}, ledger);
    return ledger;
  };

  it('for every range', () => {
    expectEqual(mixed());
  });

  it('with a Cursor account covering some days', () => {
    const account = 'a'.repeat(16);
    let ledger = ledgerWith('cursor', [usage('2026-10-28', counts(10, 1), 'composer-1'), usage('2026-10-31', counts(20, 2), 'composer-1')], [folder(`${HOME}/a`, '2026-10-28', counts(10, 1), 'composer-1'), folder(`${HOME}/a`, '2026-10-31', counts(20, 2), 'composer-1')], {}, mixed());
    ledger = mergeCursorAccount(ledger, account, '2026-10-29T12:00:00Z', [usage('2026-10-27', counts(500, 40), 'gpt-5.5'), usage('2026-10-28', counts(9, 9), 'gpt-5.5')]);
    expectEqual(ledger);
  });

  it('when folder rows exceed the total for a key', () => {
    expectEqual(ledgerWith('claude-code', [usage('2026-10-30', counts(100))], [folder(`${HOME}/a`, '2026-10-30', counts(80)), folder(`${HOME}/b`, '2026-10-30', counts(70))]));
  });
});

describe('topProjects', () => {
  const ledger = (): Ledger => ledgerWith(
    'claude-code',
    [usage('2026-10-30', counts(1000))],
    [folder(`${HOME}/a`, '2026-10-30', counts(300)), folder(`${HOME}/b`, '2026-10-30', counts(600))],
  );

  it('ranks the projects of one agent and leaves Not assigned out', () => {
    const top = topProjects(projectRows(ledger(), {}, HOME), 'agent', 'claude-code', '30d', TODAY, 5);
    expect(top.map((s) => [s.name, s.weighted, s.share])).toEqual([['b', 600, 0.6], ['a', 300, 0.3]]);
  });

  it('respects the limit', () => {
    expect(topProjects(projectRows(ledger(), {}, HOME), 'agent', 'claude-code', '30d', TODAY, 1)).toHaveLength(1);
  });

  it('matches a model by its label', () => {
    const rows = projectRows(ledger(), {}, HOME);
    const label = buildViewModel(ledger(), TODAY).days.at(-1)!.models[0]!.key;
    expect(topProjects(rows, 'model', label, '30d', TODAY, 5)).toHaveLength(2);
  });
});
