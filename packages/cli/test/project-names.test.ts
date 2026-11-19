import { describe, expect, it } from 'vitest';
import type { ProjectUsage } from '@tokengraph/core';
import { emptyLedger, mergeProjectRoots, mergeProjects, mergeUsage, type Ledger } from '../src/ledger.js';
import {
  mergeProjectNames,
  planProjectEdit,
  projectCatalogue,
  projectRoots,
  renameProjectNames,
  splitProjectNames,
  suggestMerges,
} from '../src/project-names.js';
import { NOT_ASSIGNED, projectRows, type ProjectRow } from '../src/project-usage.js';

const HOME = '/Users/me';
const counts = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });

/** Usage per root on two days, one of them a year ago, plus 1000 tokens with no project. */
function ledger(folders: Record<string, number>): Ledger {
  const total = Object.values(folders).reduce((sum, n) => sum + n, 0);
  const days = ['2025-10-01', '2026-10-30'];
  let result = emptyLedger();
  for (const date of days) {
    result = mergeUsage(result, 'claude-code', [{ date, model: 'claude-opus-4-8', pricingTier: 'standard', counts: counts(total / 2 + 500) }]);
  }
  const rows: ProjectUsage[] = days.flatMap((date) => Object.entries(folders).map(([folder, n]) => ({ folder, date, model: 'claude-opus-4-8', pricingTier: 'standard' as const, counts: counts(n / 2) })));
  return mergeProjectRoots(mergeProjects(result, 'claude-code', rows), Object.fromEntries(Object.keys(folders).map((folder) => [folder, folder])));
}

const CLI = `${HOME}/codes/tokengraph/cli`;
const SITE = `${HOME}/codes/tokengraph/tokengraph-site`;
const VIDEO = `${HOME}/codes/tokengraph/promo-video`;
const OLD = `${HOME}/codes/token-graph`;
const BLOG = `${HOME}/codes/blog`;
const NOTES = `${HOME}/codes/notes`;
const DOTS = `${HOME}/codes/dotfiles`;

const FOLDERS = { [CLI]: 6000, [SITE]: 3000, [VIDEO]: 400, [OLD]: 2000, [BLOG]: 800, [NOTES]: 100, [DOTS]: 50 };
const rows = (names: Record<string, string> = {}, folders: Record<string, number> = FOLDERS): ProjectRow[] => projectRows(ledger(folders), names, HOME);
const L = ledger(FOLDERS);

describe('projectCatalogue and projectRoots', () => {
  it('lists assigned projects over all time, biggest first, never Not assigned', () => {
    const catalogue = projectCatalogue(rows());
    expect(catalogue.map((entry) => [entry.name, entry.weighted])).toEqual([
      ['cli', 6000], ['tokengraph-site', 3000], ['token-graph', 2000], ['blog', 800], ['promo-video', 400], ['notes', 100], ['dotfiles', 50],
    ]);
    expect(catalogue.some((entry) => entry.name === NOT_ASSIGNED)).toBe(false);
  });

  it('gives a named project every root that has the name, biggest first', () => {
    expect(projectRoots(rows({ [CLI]: 'tokengraph', [OLD]: 'tokengraph' }), 'tokengraph')).toEqual([CLI, OLD]);
    expect(projectRoots(rows(), NOT_ASSIGNED)).toEqual([]);
    expect(projectRoots(rows(), 'nope')).toEqual([]);
  });
});

describe('mergeProjectNames', () => {
  it('gives every root of both projects the second name, so they count as one', () => {
    const names = { [CLI]: 'tokengraph', [OLD]: 'tokengraph' };
    const result = mergeProjectNames(names, L, 'tokengraph-site', 'tokengraph', HOME);
    expect(result).toEqual({
      ok: true,
      names: { [CLI]: 'tokengraph', [OLD]: 'tokengraph', [SITE]: 'tokengraph' },
      message: 'Merged "tokengraph-site" into "tokengraph".',
      select: 'tokengraph',
    });
    if (!result.ok) return;
    expect(projectCatalogue(rows(result.names))[0]).toMatchObject({ name: 'tokengraph', weighted: 11_000, roots: [CLI, SITE, OLD] });
  });

  it('keeps a made-up name too, and leaves other names alone', () => {
    const result = mergeProjectNames({ [BLOG]: 'writing' }, L, 'cli', 'token-graph', HOME);
    expect(result.ok && result.names).toEqual({ [BLOG]: 'writing', [CLI]: 'token-graph', [OLD]: 'token-graph' });
  });

  it('carries a root named alike that has no usage left', () => {
    const names = { [CLI]: 'tokengraph', '/gone/repo': 'tokengraph' };
    const result = mergeProjectNames(names, L, 'tokengraph', 'blog', HOME);
    expect(result.ok && result.names).toEqual({ [CLI]: 'blog', '/gone/repo': 'blog', [BLOG]: 'blog' });
  });

  it('refuses Not assigned, a project with itself and unknown names', () => {
    expect(mergeProjectNames({}, L, NOT_ASSIGNED, 'cli', HOME)).toMatchObject({ ok: false, error: expect.stringContaining('cannot be merged') });
    expect(mergeProjectNames({}, L, 'cli', NOT_ASSIGNED, HOME)).toMatchObject({ ok: false });
    expect(mergeProjectNames({}, L, 'cli', 'cli', HOME)).toEqual({ ok: false, error: '"cli" cannot be merged with itself.' });
    expect(mergeProjectNames({}, L, 'nope', 'cli', HOME)).toEqual({ ok: false, error: 'No project named "nope".' });
    expect(mergeProjectNames({}, L, 'cli', 'x\x1b[2J', HOME)).toEqual({ ok: false, error: 'No project named "x[2J".' });
  });
});

describe('renameProjectNames', () => {
  it('renames every root of a project', () => {
    const names = { [CLI]: 'tokengraph', [OLD]: 'tokengraph' };
    expect(renameProjectNames(names, L, 'tokengraph', '  tg  ', HOME)).toEqual({
      ok: true,
      names: { [CLI]: 'tg', [OLD]: 'tg' },
      message: 'Renamed "tokengraph" to "tg".',
      select: 'tg',
    });
  });

  it('allows the name of another project and says that merges them', () => {
    const result = renameProjectNames({}, L, 'token-graph', 'cli', HOME);
    expect(result).toMatchObject({ ok: true, names: { [OLD]: 'cli' }, select: 'cli' });
    expect(result.ok && result.message).toContain('now count as one');
    if (result.ok) expect(projectRoots(rows(result.names), 'cli')).toEqual([CLI, OLD]);
  });

  it('follows the same rules as `projects name`', () => {
    expect(renameProjectNames({}, L, 'cli', '\x07 ', HOME)).toMatchObject({ ok: false, error: expect.stringContaining('visible character') });
    expect(renameProjectNames({}, L, 'cli', 'NOT assigned', HOME)).toMatchObject({ ok: false });
    expect(renameProjectNames({}, L, NOT_ASSIGNED, 'x', HOME)).toMatchObject({ ok: false });
    expect(renameProjectNames({}, L, 'cli', 'cli', HOME)).toEqual({ ok: false, error: 'It is already called "cli".' });
    expect(renameProjectNames({}, L, 'cli', 'a\x1b[31mb', HOME)).toMatchObject({ ok: true, select: 'a[31mb' });
    expect(renameProjectNames({}, L, 'cli', 'x'.repeat(100), HOME)).toMatchObject({ ok: true, select: 'x'.repeat(60) });
  });
});

describe('splitProjectNames', () => {
  it('removes the names of every root, so each folder is its own project again', () => {
    const names = { [CLI]: 'tokengraph', [OLD]: 'tokengraph', [BLOG]: 'writing' };
    expect(splitProjectNames(names, L, 'tokengraph', HOME)).toEqual({
      ok: true,
      names: { [BLOG]: 'writing' },
      message: 'Split "tokengraph" into "cli", "token-graph".',
      select: 'cli',
    });
  });

  it('also drops a root named alike that has no usage left', () => {
    const names = { [CLI]: 'tokengraph', [OLD]: 'tokengraph', '/gone/repo': 'tokengraph' };
    expect(splitProjectNames(names, L, 'tokengraph', HOME)).toMatchObject({ ok: true, names: {} });
  });

  it('refuses a project with one folder, Not assigned and unknown names', () => {
    expect(splitProjectNames({ [CLI]: 'x' }, L, 'x', HOME)).toEqual({ ok: false, error: '"x" has one folder, so there is nothing to split.' });
    expect(splitProjectNames({}, L, NOT_ASSIGNED, HOME)).toMatchObject({ ok: false });
    expect(splitProjectNames({}, L, 'nope', HOME)).toMatchObject({ ok: false });
  });
});

describe('names made up and names given never mix', () => {
  const C = (path: string) => `${HOME}/code/${path}`;
  const catalogue = (folders: Record<string, number>, names: Record<string, string>) =>
    projectCatalogue(rows(names, folders)).map((entry) => [entry.name, entry.roots.map((root) => root.replace(`${HOME}/code/`, ''))]);
  const ok = (result: ReturnType<typeof mergeProjectNames>) => {
    if (!result.ok) throw new Error(result.error);
    return result.names;
  };

  it('a new folder with a merged project\'s made-up name stays its own project', () => {
    const before = { [C('tokengraph/cli')]: 5000, [C('site')]: 3000 };
    const names = ok(mergeProjectNames({}, ledger(before), 'site', 'cli', HOME));
    expect(names).toEqual({ [C('tokengraph/cli')]: 'cli', [C('site')]: 'cli' });
    expect(catalogue({ ...before, [C('other/cli')]: 100 }, names)).toEqual([['cli', ['tokengraph/cli', 'site']], ['other/cli', ['other/cli']]]);
  });

  it('renaming to a made-up name names that project\'s folders too, so the merge holds', () => {
    const before = { [C('a/cli')]: 5000, [C('site')]: 3000 };
    const names = ok(renameProjectNames({}, ledger(before), 'site', 'cli', HOME));
    expect(names).toEqual({ [C('a/cli')]: 'cli', [C('site')]: 'cli' });
    expect(catalogue({ ...before, [C('b/cli')]: 100 }, names)).toEqual([['cli', ['a/cli', 'site']], ['b/cli', ['b/cli']]]);
  });

  it('a split never hands a freed folder to a project the user named like it', () => {
    const folders = { [C('bar')]: 5000, [C('baz')]: 3000, [C('qux')]: 1000 };
    const names = { [C('bar')]: 'foo', [C('baz')]: 'foo', [C('qux')]: 'bar' };
    const result = splitProjectNames(names, ledger(folders), 'foo', HOME);
    expect(result).toEqual({ ok: true, names: { [C('qux')]: 'bar' }, message: 'Split "foo" into "code/bar", "baz".', select: 'code/bar' });
    if (result.ok) expect(catalogue(folders, result.names)).toEqual([['code/bar', ['bar']], ['baz', ['baz']], ['bar', ['qux']]]);
  });

  it('an edit never renames a project it does not touch', () => {
    const folders = { [C('x/cli')]: 5000, [C('y/cli')]: 3000, [C('z')]: 100 };
    const merged = ok(mergeProjectNames({}, ledger(folders), 'z', 'x/cli', HOME));
    expect(catalogue(folders, merged)).toEqual([['x/cli', ['x/cli', 'z']], ['y/cli', ['y/cli']]]);
    const split = splitProjectNames(merged, ledger(folders), 'x/cli', HOME);
    expect(split.ok && catalogue(folders, split.names)).toEqual([['cli', ['x/cli']], ['y/cli', ['y/cli']], ['z', ['z']]]);
    expect(split).toMatchObject({ message: 'Split "x/cli" into "cli", "z".', select: 'cli' });
    const renamed = ok(renameProjectNames({}, ledger(folders), 'x/cli', 'main', HOME));
    expect(catalogue(folders, renamed)).toEqual([['main', ['x/cli']], ['y/cli', ['y/cli']], ['z', ['z']]]);
  });
});

describe('planProjectEdit', () => {
  it('routes each edit', () => {
    expect(planProjectEdit({ projects: 'merge', project: 'cli', into: 'blog' }, {}, L, HOME)).toEqual(mergeProjectNames({}, L, 'cli', 'blog', HOME));
    expect(planProjectEdit({ projects: 'rename', project: 'cli', name: 'x' }, {}, L, HOME)).toEqual(renameProjectNames({}, L, 'cli', 'x', HOME));
    expect(planProjectEdit({ projects: 'split', project: 'cli' }, {}, L, HOME)).toEqual(splitProjectNames({}, L, 'cli', HOME));
  });
});

describe('suggestMerges', () => {
  const ranked = (project: string, names: Record<string, string> = {}, folders = FOLDERS) =>
    suggestMerges(rows(names, folders), project, HOME).map((candidate) => [candidate.name, candidate.reason]);

  it('puts the same name first, then a folder named like the other, then folders side by side, then the rest by tokens', () => {
    expect(ranked('token-graph')).toEqual([
      ['tokengraph-site', 'same-name'],
      ['cli', 'parent-name'],
      ['promo-video', 'parent-name'],
      ['blog', null],
      ['notes', null],
      ['dotfiles', null],
    ]);
    expect(ranked('cli')).toEqual([
      ['tokengraph-site', 'parent-name'],
      ['token-graph', 'parent-name'],
      ['promo-video', 'same-folder'],
      ['blog', null],
      ['notes', null],
      ['dotfiles', null],
    ]);
  });

  it('reads a name through its folders, so a renamed project still finds its siblings', () => {
    const names = { [CLI]: 'tokengraph' };
    expect(ranked('tokengraph', names).slice(0, 3)).toEqual([
      ['tokengraph-site', 'same-name'],
      ['token-graph', 'same-name'],
      ['promo-video', 'parent-name'],
    ]);
  });

  it('ignores case, separators, a made-up hash and part words, and needs four letters to match inside a name', () => {
    const folders = { '/a/x/Acme_Web': 10, '/b/x/acme': 20, '/c/acmeportal': 5, '/d/app': 4, '/e/happy': 3 };
    expect(ranked('Acme_Web', {}, folders)).toEqual([['acme', 'same-name'], ['acmeportal', 'similar-name'], ['app', null], ['happy', null]]);
    expect(ranked('app', {}, folders).find(([name]) => name === 'happy')).toEqual(['happy', null]);
    const twinNames = projectCatalogue(rows({}, { '/a/one/cli': 10, '/b/one/cli': 5, '/c/two/clix': 1 })).map((entry) => entry.name);
    expect(twinNames.every((name) => /^cli-[0-9a-f]{4}$|^clix$/.test(name))).toBe(true);
    const made = twinNames.find((name) => name.startsWith('cli-'))!;
    expect(suggestMerges(rows({}, { '/a/one/cli': 10, '/b/one/cli': 5, '/c/two/clix': 1 }), made, HOME).map((c) => c.reason)).toEqual(['same-name', null]);
  });

  it('never matches two names made of symbols only', () => {
    expect(suggestMerges(rows({ '/a/x': '++', '/b/y': '--' }, { '/a/x': 10, '/b/y': 4 }), '++', HOME)).toEqual([{ name: '--', weighted: 4, folders: 1, reason: null }]);
  });

  it('never counts the home folder, a folder right under it or a crowded folder as a family', () => {
    const folders = { [`${HOME}/alpha`]: 10, [`${HOME}/beta`]: 5, [`${HOME}/code/blog`]: 4, [`${HOME}/code/dotfiles`]: 3, [`${HOME}/code/invoice-app`]: 2 };
    for (const project of ['alpha', 'blog']) expect(suggestMerges(rows({}, folders), project, HOME).every((candidate) => candidate.reason === null)).toBe(true);
    const crowded = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => [`/w/all/${name}`, 10 - i]));
    expect(suggestMerges(rows({}, crowded), 'a', HOME).every((candidate) => candidate.reason === null)).toBe(true);
    const small = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => [`/w/all/${name}`, 10 - i]));
    expect(suggestMerges(rows({}, small), 'a', HOME).every((candidate) => candidate.reason === 'same-folder')).toBe(true);
  });

  it('finds the family of a project in a folder of four repos, beside older copies one level up', () => {
    const codes = `${HOME}/codes`;
    const folders = {
      [`${codes}/tokengraph/cli`]: 6000,
      [`${codes}/tokengraph/tokengraph-site`]: 3000,
      [`${codes}/tokengraph/promo-video`]: 400,
      [`${codes}/tokengraph/docs-site`]: 100,
      [`${codes}/token-graph`]: 2000,
      [`${codes}/tokengraph-cli`]: 1500,
      [`${codes}/blog`]: 800,
      [`${codes}/notes`]: 50,
    };
    expect(ranked('cli', {}, folders)).toEqual([
      ['tokengraph-site', 'parent-name'],
      ['token-graph', 'parent-name'],
      ['tokengraph-cli', 'parent-name'],
      ['promo-video', 'same-folder'],
      ['docs-site', 'same-folder'],
      ['blog', null],
      ['notes', null],
    ]);
    expect(ranked('token-graph', {}, folders).slice(0, 4)).toEqual([
      ['tokengraph-site', 'same-name'],
      ['tokengraph-cli', 'same-name'],
      ['cli', 'parent-name'],
      ['promo-video', 'parent-name'],
    ]);
    expect(ranked('blog', {}, folders).every(([, reason]) => reason === null)).toBe(true);
  });

  it('carries tokens and folder counts, and leaves out the project itself and Not assigned', () => {
    const names = { [CLI]: 'tokengraph', [OLD]: 'tokengraph' };
    const list = suggestMerges(rows(names), 'blog', HOME);
    expect(list.find((candidate) => candidate.name === 'tokengraph')).toEqual({ name: 'tokengraph', weighted: 8000, folders: 2, reason: null });
    expect(list.map((candidate) => candidate.name)).not.toContain('blog');
    expect(list.map((candidate) => candidate.name)).not.toContain(NOT_ASSIGNED);
  });
});
