import { describe, expect, it, vi } from 'vitest';
import type { ProjectUsage } from '@tokengraph/core';
import { emptyLedger, mergeProjectRoots, mergeProjects, mergeUsage, type Ledger } from '../../src/ledger.js';
import type { ProjectEdit, ProjectEditResult } from '../../src/project-names.js';
import { STILL } from '../../src/tui/animate.js';
import { initialState, reduce, renderFrame, requestAction, runApp, selectProject, type AppState } from '../../src/tui/app.js';
import type { InputEvent } from '../../src/tui/input.js';
import { buildViewModel, projectSummaries } from '../../src/tui/model.js';
import { toPlainText } from '../../src/tui/screen.js';
import { tuiTheme } from '../../src/tui/theme.js';
import { filterEntries, paletteEntries } from '../../src/tui/views/palette.js';

const TODAY = '2026-10-03';
const HOME = '/Users/me';
const CLI = `${HOME}/code/tokengraph/cli`;
const SITE = `${HOME}/code/tokengraph/tokengraph-site`;
const BLOG = `${HOME}/code/blog`;
const counts = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });

/** cli 6000, tokengraph-site 3000, blog 800, and 200 with no project. */
function ledger(): Ledger {
  const folders = { [CLI]: 6000, [SITE]: 3000, [BLOG]: 800 };
  const usage: ProjectUsage[] = Object.entries(folders).map(([folder, n]) => ({ folder, date: TODAY, model: 'claude-opus-4-8', pricingTier: 'standard', counts: counts(n) }));
  return mergeProjectRoots(
    mergeProjects(mergeUsage(emptyLedger(), 'claude-code', [{ date: TODAY, model: 'claude-opus-4-8', pricingTier: 'standard', counts: counts(10_000) }]), 'claude-code', usage),
    Object.fromEntries(Object.keys(folders).map((folder) => [folder, folder])),
  );
}

const char = (c: string): InputEvent => ({ type: 'char', char: c });
const key = (k: 'enter' | 'escape' | 'down' | 'left' | 'up'): InputEvent => ({ type: 'key', key: k });

function projectsTab(names: Record<string, string> = {}): AppState {
  const state = initialState(buildViewModel(ledger(), TODAY, { home: HOME, projectNames: names }), 'local only');
  return reduce(state, char('4'), null).state;
}

function press(state: AppState, ...events: InputEvent[]) {
  let current = state;
  const effects: unknown[] = [];
  for (const event of events) {
    const out = reduce(current, event, null);
    current = out.state;
    effects.push(...out.effects);
  }
  return { state: current, effects };
}

describe('the project boxes in the reducer', () => {
  it('m, n and x open the merge, rename and split boxes for the selected project on the Projects tab only', () => {
    const tab = projectsTab({ [CLI]: 'tokengraph', [SITE]: 'tokengraph' });
    expect(press(tab, char('m')).state.projectPanel).toMatchObject({ kind: 'merge', project: 'tokengraph' });
    expect(press(tab, char('n')).state.projectPanel).toMatchObject({ kind: 'rename', project: 'tokengraph', text: 'tokengraph' });
    expect(press(tab, char('x')).state.projectPanel).toMatchObject({ kind: 'split', project: 'tokengraph', folders: ['~/code/tokengraph/cli', '~/code/tokengraph/tokengraph-site'] });
    const second = press(tab, key('down'), char('m')).state.projectPanel;
    expect(second).toMatchObject({ kind: 'merge', project: 'blog' });
    const overview = initialState(buildViewModel(ledger(), TODAY, { home: HOME }), 'local only');
    for (const c of ['m', 'n', 'x']) expect(press(overview, char(c))).toEqual({ state: overview, effects: [] });
  });

  it('gives Not assigned and a one-folder split a neutral toast instead of a box', () => {
    const tab = projectsTab();
    const split = press(tab, char('x'));
    expect(split.state.projectPanel).toBeNull();
    expect(split.effects).toEqual([{ toast: 'cli has one folder: nothing to split.', tone: 'info' }]);
    const last = press(tab, key('down'), key('down'), key('down'));
    expect(projectSummaries(last.state.vm, last.state.table.range)[last.state.table.selected]?.name).toBe('Not assigned');
    for (const c of ['m', 'n', 'x']) {
      const out = press(last.state, char(c));
      expect(out.state.projectPanel).toBeNull();
      expect(out.effects).toEqual([{ toast: expect.stringMatching(/^Not assigned cannot be (merged|renamed|split)\.$/), tone: 'info' }]);
    }
  });

  it('opens nothing while an action runs or another box is open', () => {
    const tab = projectsTab();
    for (const busy of [
      { ...tab, running: 'sync' as const },
      { ...tab, running: 'projects' as const },
      requestAction(tab, 'schedule').state,
      { ...tab, palette: { query: '', selected: 0 } },
      { ...tab, help: true },
    ]) {
      expect(press(busy, char('m')).state.projectPanel).toBeNull();
    }
    const opened = press(tab, char('m')).state;
    expect(press(opened, char('n')).state.projectPanel).toMatchObject({ kind: 'merge', filter: 'n' });
  });

  it('keeps every key inside the box, and an edit closes it, holds the view and asks the app to apply it', () => {
    const opened = press(projectsTab(), char('m')).state;
    const typed = press(opened, char('q'), char('s'), char('1'));
    expect(typed.effects).toEqual([]);
    expect(typed.state.tab).toBe('projects');
    expect(typed.state.projectPanel).toMatchObject({ filter: 'qs1' });
    expect(press(opened, { type: 'ctrl', char: 'c' })).toEqual({ state: { ...opened, projectPanel: null }, effects: [] });
    // The bigger project's name is offered first; ← keeps the other one's.
    const merged = press(opened, key('enter'), key('enter'));
    expect(merged.state.projectPanel).toBeNull();
    expect(merged.state.running).toBe('projects');
    expect(merged.effects).toEqual([{ projects: 'merge', project: 'tokengraph-site', into: 'cli' }]);
    expect(press(opened, key('enter'), key('left'), key('enter')).effects).toEqual([{ projects: 'merge', project: 'cli', into: 'tokengraph-site' }]);
    expect(press(merged.state, char('m')).state.projectPanel).toBeNull();
    expect(requestAction(merged.state, 'status').effects).toEqual([]);
  });

  it('opens the boxes from the palette, on the Projects tab', () => {
    const state = initialState(buildViewModel(ledger(), TODAY, { home: HOME }), 'local only');
    const entry = filterEntries(paletteEntries(state), 'merge')[0]!;
    expect(entry).toMatchObject({ title: 'Merge projects', detail: 'key m', target: { project: 'merge' } });
    const out = press(state, char(':'), ...[...'merge'].map(char), key('enter'));
    expect(out.state.tab).toBe('projects');
    expect(out.state.projectPanel).toMatchObject({ kind: 'merge', project: 'cli' });
    expect(filterEntries(paletteEntries(state), 'rename')[0]?.target).toEqual({ project: 'rename' });
    expect(filterEntries(paletteEntries(state), 'split')[0]?.target).toEqual({ project: 'split' });
  });

  it('selectProject follows a project by name and keeps the row when the range does not show it', () => {
    const tab = projectsTab();
    expect(selectProject(tab, 'blog').table.selected).toBe(2);
    expect(selectProject({ ...tab, table: { ...tab.table, selected: 1 } }, 'gone').table.selected).toBe(1);
  });
});

describe('the project boxes on screen', () => {
  it('draws the box over the view, hides the view keys, and lists m n x in the Projects hints and the help', () => {
    const tab = projectsTab();
    const plain = toPlainText(renderFrame(tab, { theme: 'dark' }, 180, 40, STILL).buffer);
    expect(plain).toContain('m merge  n rename  x split');
    const open = toPlainText(renderFrame(press(tab, char('m')).state, { theme: 'dark' }, 120, 36, STILL).buffer);
    expect(open).toContain('MERGE PROJECTS');
    expect(open).toContain('Merge "cli" with…');
    expect(open).not.toContain('↑↓ select');
    const help = toPlainText(renderFrame({ ...tab, help: true }, { theme: 'dark' }, 120, 40, STILL).buffer);
    expect(help).toContain('merge / rename / split a project (Projects)');
  });

  it('draws an info toast in the muted colour', () => {
    const theme = tuiTheme('dark');
    const state = { ...projectsTab(), toast: { text: 'Not assigned cannot be merged.', tone: 'info' as const, at: 0 } };
    // Whole beside the key hints at the smallest width the view draws.
    const { buffer } = renderFrame(state, { theme: 'dark' }, 80, 24, { ...STILL, now: 0 });
    const last = toPlainText(buffer).split('\n').at(-1)!;
    expect(last).toContain('· Not assigned cannot be merged.');
    const x = last.indexOf('· Not assigned');
    expect(x).toBeGreaterThan(0);
    expect(buffer.get(x + 2, buffer.height - 1)?.fg).toBe(theme.muted);
  });
});

describe('runApp applies project edits', () => {
  const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  function start(over: Record<string, unknown> = {}) {
    let last = '';
    let input: (events: unknown[]) => void = () => {};
    const names: { value: Record<string, string> } = { value: {} };
    const calls: string[] = [];
    const editProjects = vi.fn(async (edit: ProjectEdit): Promise<ProjectEditResult> => {
      calls.push(`edit:${edit.projects}`);
      if (edit.projects !== 'merge') return { ok: false, error: 'Could not write config.json.' };
      names.value = { [CLI]: edit.into, [SITE]: edit.into };
      return { ok: true, names: names.value, message: `Merged "${edit.project}" into "${edit.into}".`, select: edit.into };
    });
    const deps = {
      onFrame: (buffer: never) => void (last = toPlainText(buffer)),
      terminal: { width: 120, height: 36, write: () => {}, onInput: (fn: typeof input) => void (input = fn), onResize: () => {}, restore: () => {} },
      depth: 'none', theme: 'dark', motion: false, live: false, home: HOME,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => ledger(),
      scan: async (l: Ledger) => (calls.push('scan'), { ledger: l, results: [], failures: [], detected: [] }),
      persist: async () => 'saved', modeLabel: async () => 'local only',
      autoSync: async () => ({ claudeHook: null, cursorHook: null, codexNotify: null, geminiHook: null, schedule: null }),
      checkForUpdate: async () => {}, setupStatus: async () => ({ login: null, autoSync: null, cursorFetch: null, graphColors: 'model' }),
      projectNames: async () => (calls.push('names'), names.value),
      editProjects,
      setTimer: (fn: () => void, ms: number) => { const t = setTimeout(fn, Math.min(ms, 5)); return () => clearTimeout(t); },
      ...over,
    };
    const done = runApp(deps as never);
    return { done, calls, editProjects, names, send: (...events: InputEvent[]) => input(events), text: () => last };
  }

  it('writes the merge, reloads the names, selects the merged project and says so', async () => {
    const app = start();
    await wait();
    app.send(char('4'), char('m'), ...[...'site'].map(char));
    await wait();
    expect(app.text()).toContain('▸ ● tokengraph-site');
    app.send(key('enter'));
    await wait();
    expect(app.text()).toContain('"cli" and "tokengraph-site" will count as one project.');
    app.send(key('enter'));
    await wait();
    // Planned against the ledger the view shows.
    expect(app.editProjects).toHaveBeenCalledWith({ projects: 'merge', project: 'tokengraph-site', into: 'cli' }, ledger());
    expect(app.text()).not.toContain('MERGE PROJECTS');
    expect(app.text()).toContain('✓ Merged "tokengraph-site" into "cli".');
    expect(app.text()).toMatch(/▀ cli .* 9\.0K/);
    expect(app.text()).not.toMatch(/▀ tokengraph-site/);
    // The names are read again after the write, and the scans start again after that.
    const edit = app.calls.indexOf('edit:merge');
    expect(app.calls.indexOf('names', edit)).toBeGreaterThan(edit);
    expect(app.calls.indexOf('scan', edit)).toBeGreaterThan(app.calls.indexOf('names', edit));
    app.send(char('q'));
    expect(await app.done).toBe(0);
  });

  it('shows a refused or failed edit as a red toast and lets the view go on', async () => {
    const app = start();
    await wait();
    app.send(char('4'), char('n'), char('2'), key('enter'));
    await wait();
    expect(app.text()).toContain('✗ Could not write config.json.');
    app.send(char('m'));
    await wait();
    expect(app.text()).toContain('MERGE PROJECTS');
    // Sent apart: an Esc followed at once by a key reads as an Alt chord.
    app.send(key('escape'));
    app.send(char('q'));
    expect(await app.done).toBe(0);

    const broken = start({ editProjects: async () => { throw new Error('EACCES: config.json'); } });
    await wait();
    broken.send(char('4'), char('n'), char('2'), key('enter'));
    await wait();
    expect(broken.text()).toContain('✗ EACCES: config.json');
    broken.send(char('q'));
    expect(await broken.done).toBe(0);
  });

  it('waits for a scan in flight before writing, so the scan cannot put the old names back', async () => {
    let release: () => void = () => {};
    let first = true;
    const app = start({
      scan: (l: Ledger) => {
        if (!first) return Promise.resolve({ ledger: l, results: [], failures: [], detected: [] });
        first = false;
        return new Promise((resolve) => { release = () => resolve({ ledger: l, results: [], failures: [], detected: [] }); });
      },
    });
    await wait();
    app.send(char('4'), char('m'), key('enter'), key('enter'));
    await wait();
    expect(app.editProjects).not.toHaveBeenCalled();
    release();
    await wait();
    expect(app.editProjects).toHaveBeenCalledTimes(1);
    const scanEnd = app.calls.indexOf('names');
    expect(scanEnd).toBeLessThan(app.calls.indexOf('edit:merge'));
    expect(app.text()).toContain('✓ Merged');
    expect(app.text()).toMatch(/▀ cli .* 9\.0K/);
    app.send(char('q'));
    expect(await app.done).toBe(0);
  });
});
