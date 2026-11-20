import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { ProjectUsage } from '@tokengraph/core';
import { editProjects, parseProjectsArgs, runProjects, runProjectsMerge, runProjectsName, runProjectsShow, runProjectsSplit, type ProjectsDeps } from '../src/commands/projects.js';
import type { CliConfig } from '../src/config.js';
import { emptyLedger, mergeProjectRoots, mergeProjects, mergeUsage, type Ledger } from '../src/ledger.js';
import { normaliseFolder } from '../src/project-roots.js';

// Absolute on this platform: on Windows `resolve` puts a drive in front of a bare `/Users/me`.
const HOME = normaliseFolder(resolve('/Users/me'));
const TODAY = '2026-11-01';
const counts = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });
const row = (folder: string, input: number): ProjectUsage => ({ folder, date: '2026-10-30', model: 'claude-opus-4-8', pricingTier: 'standard', counts: counts(input) });

function ledger(): Ledger {
  const a = `${HOME}/code/cli`;
  const b = `${HOME}/code/site`;
  const c = `${HOME}/other/cli`;
  return mergeProjectRoots(
    mergeProjects(mergeUsage(emptyLedger(), 'claude-code', [{ date: '2026-10-30', model: 'claude-opus-4-8', pricingTier: 'standard', counts: counts(1000) }]), 'claude-code', [
      row(a, 500), row(`${a}/src`, 100), row(b, 200), row(c, 50),
    ]),
    { [a]: a, [`${a}/src`]: a, [b]: b, [c]: c },
  );
}

describe('tokengraph projects', () => {
  let out: string[];
  let err: string[];
  let config: CliConfig;
  const deps = (over: Partial<ProjectsDeps> = {}): Partial<ProjectsDeps> => ({
    ledger: async () => ledger(),
    config: async () => config,
    saveConfig: async (next) => void (config = next),
    today: () => TODAY,
    home: () => HOME,
    cwd: () => `${HOME}/code`,
    ...over,
  });

  beforeEach(() => {
    out = [];
    err = [];
    config = {};
    vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void err.push(args.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const text = () => out.join('\n');

  describe('list', () => {
    it('ranks projects, ends with Not assigned and says the cost is an estimate for this machine', async () => {
      expect(await runProjects({ range: '30d', json: false }, deps())).toBe(0);
      const lines = text().split('\n');
      const position = (name: string) => lines.findIndex((line) => line.includes(name));
      expect(position('code/cli')).toBeLessThan(position('site'));
      expect(position('site')).toBeLessThan(position('Not assigned'));
      expect(text()).toMatch(/estimate/i);
      expect(text()).toMatch(/this machine/i);
      expect(text()).not.toContain(HOME);
    });

    it('holds the same numbers in JSON, without folder paths', async () => {
      await runProjects({ range: '30d', json: true }, deps());
      const parsed = JSON.parse(text()) as { scope: string; range: string; projects: { name: string; weightedTokens: number; assigned: boolean }[] };
      expect(parsed).toMatchObject({ scope: 'this-machine', range: '30d' });
      expect(parsed.projects.map((p) => [p.name, p.weightedTokens, p.assigned])).toEqual([
        ['code/cli', 600, true],
        ['site', 200, true],
        ['other/cli', 50, true],
        ['Not assigned', 150, false],
      ]);
      expect(text()).not.toContain(HOME);
    });

    it('says what to do when there is no usage in the range', async () => {
      expect(await runProjects({ range: '7d', json: false }, deps({ ledger: async () => emptyLedger() }))).toBe(0);
      expect(text()).toContain('No usage in the last 7 days. Try --range all');
    });

    it('reads properly when there is no usage at all', async () => {
      expect(await runProjects({ range: 'all', json: false }, deps({ ledger: async () => emptyLedger() }))).toBe(0);
      expect(text()).toBe('No usage yet. Run `tokengraph sync --local` to read your agents.');
    });
  });

  describe('show', () => {
    it('prints the models, the agents and the folders', async () => {
      expect(await runProjectsShow('code/cli', { range: '30d', json: false }, deps())).toBe(0);
      expect(text()).toContain('Claude Code');
      expect(text()).toMatch(/Opus/);
      expect(text()).toContain(`${HOME}/code/cli`);
    });

    it('never prints a control character from a folder or a model name, in text or JSON', async () => {
      const evil = `${HOME}/code/x\x1b]0;pwned\x07\x9b2J`;
      const dirty = (): Ledger =>
        mergeProjects(
          mergeUsage(emptyLedger(), 'claude-code', [{ date: '2026-10-30', model: 'model\x1b[2J', pricingTier: 'standard', counts: counts(10) }]),
          'claude-code',
          [{ ...row(evil, 10), model: 'model\x1b[2J' }],
        );
      const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
      const name = 'code/x]0;pwned2J'.split('/').at(-1)!;
      expect(await runProjectsShow(name, { range: '30d', json: false }, deps({ ledger: async () => dirty() }))).toBe(0);
      expect(text()).not.toMatch(control);
      out = [];
      expect(await runProjectsShow(name, { range: '30d', json: true }, deps({ ledger: async () => dirty() }))).toBe(0);
      expect(text()).not.toMatch(control);
      expect(JSON.parse(text())).toMatchObject({ scope: 'this-machine' });
    });

    it('exits 1 for an unknown name and lists the names', async () => {
      expect(await runProjectsShow('nope', { range: '30d', json: false }, deps())).toBe(1);
      expect(err.join('\n')).toContain('site');
      expect(err.join('\n')).toContain('in the last 30 days');
    });

    it('reads properly for an unknown name across all time', async () => {
      expect(await runProjectsShow('nope', { range: 'all', json: false }, deps())).toBe(1);
      expect(err.join('\n')).toContain('No project named "nope". Projects:');
    });
  });

  describe('name', () => {
    it('stores root → name, and two roots with one name merge', async () => {
      expect(await runProjectsName('site', 'tokengraph', deps())).toBe(0);
      expect(await runProjectsName('code/cli', 'tokengraph', deps())).toBe(0);
      // other/cli keeps its name: with code/cli named, it would otherwise be plain cli.
      expect(config.projects?.names).toEqual({ [`${HOME}/code/site`]: 'tokengraph', [`${HOME}/code/cli`]: 'tokengraph', [`${HOME}/other/cli`]: 'other/cli' });
      out = [];
      await runProjects({ range: '30d', json: true }, deps());
      expect((JSON.parse(text()) as { projects: { name: string; weightedTokens: number }[] }).projects[0]).toMatchObject({ name: 'tokengraph', weightedTokens: 800 });
    });

    it('takes a folder path, relative to where it runs, and finds its project', async () => {
      expect(await runProjectsName('./cli/src', 'tokengraph', deps())).toBe(0);
      expect(config.projects?.names).toEqual({ [`${HOME}/code/cli`]: 'tokengraph', [`${HOME}/other/cli`]: 'other/cli' });
    });

    it('naming a project like another one merges them for good, and moves no other name', async () => {
      expect(await runProjectsName('site', 'other/cli', deps())).toBe(0);
      expect(config.projects?.names).toEqual({ [`${HOME}/code/site`]: 'other/cli', [`${HOME}/other/cli`]: 'other/cli', [`${HOME}/code/cli`]: 'code/cli' });
    });

    it('renames every root of a project that already has several', async () => {
      config = { projects: { names: { [`${HOME}/code/cli`]: 'old', [`${HOME}/code/site`]: 'old' } } };
      expect(await runProjectsName('old', 'new', deps())).toBe(0);
      expect(Object.values(config.projects!.names!)).toEqual(['new', 'new']);
    });

    it('takes . and .. as folders', async () => {
      expect(await runProjectsName('.', 'tokengraph', deps({ cwd: () => `${HOME}/code/site` }))).toBe(0);
      expect(config.projects?.names).toEqual({ [`${HOME}/code/site`]: 'tokengraph' });
      expect(await runProjectsName('..', 'other', deps({ cwd: () => `${HOME}/code/site/src` }))).toBe(0);
      expect(config.projects?.names).toEqual({ [`${HOME}/code/site`]: 'other' });
    });

    it('never lets a folder fall through to the Home folder project', async () => {
      const inHome = (): Ledger => mergeProjectRoots(mergeProjects(ledger(), 'claude-code', [row(HOME, 5)]), { [HOME]: HOME });
      expect(await runProjectsName('./', 'acme', deps({ ledger: async () => inHome(), cwd: () => `${HOME}/never/ran/here` }))).toBe(1);
      expect(config.projects).toBeUndefined();
    });

    it('--reset removes the name', async () => {
      config = { projects: { names: { [`${HOME}/code/site`]: 'x' } } };
      expect(await runProjectsName('x', null, deps())).toBe(0);
      expect(config.projects?.names ?? {}).toEqual({});
    });

    it('refuses a target that fits two projects and lists them', async () => {
      expect(await runProjectsName('cli', 'x', deps())).toBe(1);
      expect(err.join('\n')).toContain('code/cli');
      expect(err.join('\n')).toContain('other/cli');
      expect(config.projects).toBeUndefined();
    });

    it('refuses the name of the Not assigned row, in any case', async () => {
      expect(await runProjectsName('site', 'not ASSIGNED', deps())).toBe(1);
      expect(config.projects).toBeUndefined();
    });

    it('refuses to rename the Not assigned row', async () => {
      expect(await runProjectsName('Not assigned', 'x', deps())).toBe(1);
    });

    it('strips control characters, and refuses a name with nothing left', async () => {
      await runProjectsName('site', 'a\x1b[31mb', deps());
      expect(config.projects?.names?.[`${HOME}/code/site`]).toBe('a[31mb');
      expect(await runProjectsName('site', '\x07', deps())).toBe(1);
    });

    it('exits 1 for a folder with no recorded usage', async () => {
      expect(await runProjectsName('/somewhere/else', 'x', deps())).toBe(1);
    });
  });

  describe('merge and split', () => {
    const projects = async (): Promise<[string, number][]> => {
      out = [];
      await runProjects({ range: '30d', json: true }, deps());
      return (JSON.parse(text()) as { projects: { name: string; weightedTokens: number }[] }).projects.map((p) => [p.name, p.weightedTokens]);
    };

    it('merge gives both projects the second name, and split takes it off again', async () => {
      expect(await runProjectsMerge('site', 'code/cli', deps())).toBe(0);
      expect(text()).toBe('Merged "site" into "code/cli".');
      // The other cli folder keeps its name rather than become plain cli.
      expect(config.projects?.names).toEqual({ [`${HOME}/code/cli`]: 'code/cli', [`${HOME}/code/site`]: 'code/cli', [`${HOME}/other/cli`]: 'other/cli' });
      expect(await projects()).toEqual([['code/cli', 800], ['other/cli', 50], ['Not assigned', 150]]);

      out = [];
      expect(await runProjectsSplit('code/cli', deps())).toBe(0);
      expect(text()).toBe('Split "code/cli" into "cli", "site".');
      expect(config.projects?.names).toEqual({ [`${HOME}/other/cli`]: 'other/cli' });
      expect(await projects()).toEqual([['cli', 600], ['site', 200], ['other/cli', 50], ['Not assigned', 150]]);
    });

    it('reads a folder or the last part of a path, like `projects name`', async () => {
      expect(await runProjectsMerge('./site', 'other/cli', deps())).toBe(0);
      expect(config.projects?.names).toEqual({ [`${HOME}/code/site`]: 'other/cli', [`${HOME}/other/cli`]: 'other/cli', [`${HOME}/code/cli`]: 'code/cli' });
    });

    it('splits only by exact name or folder path, never by the last part of a path', async () => {
      config = { projects: { names: { [`${HOME}/code/cli`]: 'tg', [`${HOME}/code/site`]: 'tg' } } };
      const save = vi.fn(async () => {});
      expect(await runProjectsSplit('site', deps({ saveConfig: save }))).toBe(1);
      expect(err.join('\n')).toContain('No project named "site". Give a project\'s exact name');
      expect(save).not.toHaveBeenCalled();
      expect(await runProjectsSplit('./site', deps())).toBe(0);
      // other/cli showed as cli while code/cli had a name, and keeps it.
      expect(config.projects?.names).toEqual({ [`${HOME}/other/cli`]: 'cli' });
    });

    it('keeps names set elsewhere in the config', async () => {
      config = { machineId: '11111111-2222-3333-4444-555555555555', projects: { names: { '/elsewhere': 'kept' } } };
      expect(await runProjectsMerge('site', 'other/cli', deps())).toBe(0);
      expect(config.machineId).toBe('11111111-2222-3333-4444-555555555555');
      expect(config.projects?.names?.['/elsewhere']).toBe('kept');
    });

    it('refuses an ambiguous or unknown target, Not assigned, itself and a one-folder split, and writes nothing', async () => {
      const save = vi.fn(async () => {});
      expect(await runProjectsMerge('cli', 'site', deps({ saveConfig: save }))).toBe(1);
      expect(err.join('\n')).toContain('fits several projects');
      expect(await runProjectsMerge('site', 'nope', deps({ saveConfig: save }))).toBe(1);
      expect(err.join('\n')).toContain('No recorded usage for "nope"');
      expect(await runProjectsMerge('Not assigned', 'site', deps({ saveConfig: save }))).toBe(1);
      expect(await runProjectsMerge('site', 'site', deps({ saveConfig: save }))).toBe(1);
      expect(err.join('\n')).toContain('cannot be merged with itself');
      expect(await runProjectsSplit('./site', deps({ saveConfig: save }))).toBe(1);
      expect(err.join('\n')).toContain('nothing to split');
      expect(save).not.toHaveBeenCalled();
    });

    it('editProjects takes exact names, re-reads the config and reports the outcome without printing', async () => {
      config = { projects: { names: { [`${HOME}/code/site`]: 'web' } } };
      const result = await editProjects({ projects: 'rename', project: 'web', name: 'site' }, deps());
      expect(result).toEqual({ ok: true, names: { [`${HOME}/code/site`]: 'site' }, message: 'Renamed "web" to "site".', select: 'site' });
      expect(config.projects?.names).toEqual({ [`${HOME}/code/site`]: 'site' });
      expect(await editProjects({ projects: 'merge', project: 'site', into: 'gone' }, deps())).toEqual({ ok: false, error: 'No project named "gone".' });
      expect(out).toEqual([]);
      expect(err).toEqual([]);
    });
  });

  describe('parseProjectsArgs', () => {
    it('defaults to a 30-day list', () => {
      expect(parseProjectsArgs({}, [])).toEqual({ action: 'list', range: '30d', json: false });
    });

    it('reads show and name', () => {
      expect(parseProjectsArgs({ range: 'all', json: true }, ['show', 'x'])).toEqual({ action: 'show', name: 'x', range: 'all', json: true });
      expect(parseProjectsArgs({}, ['name', 'cli', 'tokengraph'])).toEqual({ action: 'name', target: 'cli', name: 'tokengraph' });
      expect(parseProjectsArgs({ reset: true }, ['name', 'cli'])).toEqual({ action: 'name', target: 'cli', name: null });
    });

    it('reads merge and split', () => {
      expect(parseProjectsArgs({}, ['merge', 'cli', 'tokengraph'])).toEqual({ action: 'merge', project: 'cli', into: 'tokengraph' });
      expect(parseProjectsArgs({}, ['split', 'tokengraph'])).toEqual({ action: 'split', project: 'tokengraph' });
    });

    it('rejects anything else', () => {
      for (const [values, positionals] of [[{ range: '5d' }, []], [{}, ['bogus']], [{}, ['show']], [{}, ['name', 'x']], [{ reset: true }, ['name', 'x', 'y']], [{}, ['show', 'x', 'y']], [{}, ['merge', 'x']], [{}, ['merge', 'x', 'y', 'z']], [{ reset: true }, ['merge', 'x', 'y']], [{}, ['split']], [{}, ['split', 'x', 'y']]] as const) {
        expect(typeof parseProjectsArgs(values, [...positionals])).toBe('string');
      }
    });
  });
});
