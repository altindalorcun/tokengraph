import { describe, expect, it, vi } from 'vitest';
import { mergeProjects, emptyLedger, mergeHours, mergeUsage } from '../../src/ledger.js';
import { STILL } from '../../src/tui/animate.js';
import { fitHints, initialState, reduce, renderFrame, requestAction, runApp, withViewModel } from '../../src/tui/app.js';
import { buildViewModel, shiftDate } from '../../src/tui/model.js';
import { toPlainText } from '../../src/tui/screen.js';
import { actionItems, type SetupStatus } from '../../src/tui/actions.js';
import { limitViews } from '@tokengraph/core';
import type { AppState } from '../../src/tui/app-state.js';
import type { InputEvent } from '../../src/tui/input.js';
import { qrMatrix } from '../../src/share/qr.js';
import type { StoryEvent } from '../../src/tui/story-session.js';
import { startTaskSession, type TaskEvent, type TaskRun } from '../../src/tui/task-session.js';
import { askText, askYesNo } from '../../src/prompt.js';

const TODAY = '2026-10-03';
const c = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });

function state() {
  let ledger = emptyLedger();
  for (let i = 0; i < 20; i += 1) {
    ledger = mergeUsage(ledger, 'claude-code', [{ date: shiftDate(TODAY, -i), model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(1000 + i) }]);
  }
  return initialState(buildViewModel(ledger, TODAY), 'local only');
}

describe('reduce', () => {
  it('switches tabs with digits and Tab, requesting bars and wipe', () => {
    let s = state();
    let out = reduce(s, { type: 'char', char: '2' }, null);
    expect(out.state.tab).toBe('models');
    expect(out.effects).toEqual(expect.arrayContaining(['bars', 'wipe']));
    out = reduce(out.state, { type: 'key', key: 'tab' }, null);
    expect(out.state.tab).toBe('agents');
    out = reduce(out.state, { type: 'key', key: 'backtab' }, null);
    expect(out.state.tab).toBe('models');
    s = out.state;
    expect(reduce(s, { type: 'char', char: 'q' }, null).effects).toContain('quit');
    expect(reduce(s, { type: 'ctrl', char: 'c' }, null).effects).toContain('quit');
  });

  it('moves the day cursor and clamps it to today', () => {
    const s = state();
    expect(s.overview.cursor).toBe(TODAY);
    expect(reduce(s, { type: 'key', key: 'right' }, null).state.overview.cursor).toBe(TODAY);
    expect(reduce(s, { type: 'key', key: 'left' }, null).state.overview.cursor).toBe(shiftDate(TODAY, -7));
    expect(reduce(s, { type: 'key', key: 'up' }, null).state.overview.cursor).toBe(shiftDate(TODAY, -1));
    const back = reduce(s, { type: 'char', char: '[' }, null).state;
    expect(back.overview.yearEnd).toBe(shiftDate(TODAY, -364));
    expect(reduce(back, { type: 'char', char: ']' }, null).state.overview.yearEnd).toBe(TODAY);
    expect(reduce(back, { type: 'char', char: 't' }, null).state.overview).toEqual({ cursor: TODAY, yearEnd: TODAY });
  });

  it('picks the Insights hour with left/right, from the busiest and round midnight, and with the mouse', () => {
    let ledger = mergeUsage(emptyLedger(), 'claude-code', [{ date: TODAY, model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(1000) }]);
    ledger = mergeHours(ledger, 'claude-code', [{ date: TODAY, hour: 23, weighted: 900 }, { date: TODAY, hour: 9, weighted: 100 }]);
    const s = reduce(initialState(buildViewModel(ledger, TODAY), 'local only'), { type: 'char', char: '5' }, null).state;
    expect(s.clockHour).toBeNull();
    const next = reduce(s, { type: 'key', key: 'right' }, null).state;
    expect(next.clockHour).toBe(0); // 23 + 1 wraps to midnight
    expect(reduce(s, { type: 'key', key: 'left' }, null).state.clockHour).toBe(22);
    expect(reduce(next, { type: 'key', key: 'left' }, null).state.clockHour).toBe(23);
    // Without hour data the keys do nothing.
    expect(reduce(reduce(state(), { type: 'char', char: '4' }, null).state, { type: 'key', key: 'right' }, null).state.clockHour).toBeNull();
    // The mouse picks the hour under it, from the hits the frame reports.
    const { hits } = renderFrame(s, { theme: 'dark' }, 160, 48, STILL);
    const nine = hits.view.hits.find((h) => h.kind === 'hour' && h.hour === 9)!;
    expect(reduce(s, { type: 'mouse', action: 'move', button: 0, x: nine.rect.x, y: nine.rect.y }, hits).state.clockHour).toBe(9);
  });

  it('steps the range with left/right on Models and Agents but moves the day cursor on Overview', () => {
    for (const tab of ['2', '3']) {
      const s = reduce(state(), { type: 'char', char: tab }, null).state;
      const next = reduce(s, { type: 'key', key: 'right' }, null).state;
      expect(next.table.range).toBe('90d');
      expect(reduce(next, { type: 'key', key: 'left' }, null).state.table.range).toBe(s.table.range);
      expect(reduce(s, { type: 'key', key: 'left' }, null).state.table.range).not.toBe(s.table.range);
    }
    const overview = state();
    expect(reduce(overview, { type: 'key', key: 'left' }, null).state.table.range).toBe(overview.table.range);
  });

  it('cycles ranges, toggles colour and help, requests rescans', () => {
    let s = reduce(state(), { type: 'char', char: '2' }, null).state;
    s = reduce(s, { type: 'char', char: 'r' }, null).state;
    expect(s.table.range).toBe('90d');
    expect(reduce(s, { type: 'char', char: 'c' }, null).state.colorMode).toBe('single');
    const help = reduce(s, { type: 'char', char: '?' }, null).state;
    expect(help.help).toBe(true);
    const closed = reduce(help, { type: 'key', key: 'escape' }, null);
    expect(closed.state.help).toBe(false);
    expect(closed.effects).not.toContain('quit');
    expect(reduce(s, { type: 'char', char: 's' }, null).effects).toContain('rescan');
  });

  it('selects a day under the mouse', () => {
    const s = state();
    const { hits } = renderFrame(s, { theme: 'dark' }, 160, 40, STILL);
    const heat = hits.view.heatmap!;
    const x = heat.layout.originX + heat.layout.step * (51 - heat.layout.firstColumn) - heat.layout.step; // previous week, same weekday
    const y = heat.layout.originY + 6;
    const next = reduce(s, { type: 'mouse', action: 'move', x, y, button: 3 }, hits).state;
    expect(next.overview.cursor).toBe(shiftDate(TODAY, -7));
  });
});

describe('requestAction', () => {
  it('asks first when the action has a confirmation, then runs on y or Enter', () => {
    const asked = requestAction(state(), 'hook:claude-code');
    expect(asked.effects).toEqual([]);
    expect(asked.state.confirm).toEqual({ id: 'hook:claude-code', text: expect.stringContaining('Claude Code hook') });
    const yes = reduce(asked.state, { type: 'char', char: 'y' }, null);
    expect(yes.effects).toEqual([{ run: 'hook:claude-code' }]);
    expect(yes.state.confirm).toBeNull();
    expect(reduce(asked.state, { type: 'key', key: 'enter' }, null).effects).toEqual([{ run: 'hook:claude-code' }]);
  });

  it('cancels on n or Esc and ignores every other key while asking', () => {
    const asked = requestAction(state(), 'schedule').state;
    for (const event of [{ type: 'char', char: 'n' }, { type: 'key', key: 'escape' }] as const) {
      const out = reduce(asked, event, null);
      expect(out.state.confirm).toBeNull();
      expect(out.effects).toEqual([]);
    }
    for (const event of [{ type: 'char', char: 'q' }, { type: 'char', char: '2' }, { type: 'key', key: 'tab' }] as const) {
      const out = reduce(asked, event, null);
      expect(out.state.confirm).toEqual(asked.confirm);
      expect(out.effects).toEqual([]);
    }
  });

  it('quits on Ctrl-C even while asking', () => {
    const asked = requestAction(state(), 'schedule').state;
    expect(reduce(asked, { type: 'ctrl', char: 'c' }, null).effects).toEqual(['quit']);
  });

  it('runs at once when there is nothing to confirm, and does nothing while another action runs', () => {
    const opened = requestAction(state(), 'status');
    expect(opened.effects).toEqual([{ task: 'start', id: 'status' }]);
    expect(opened.state).toMatchObject({ running: 'status', task: { id: 'status', title: 'Show status', started: false } });
    const busy = { ...state(), running: 'sync' as const };
    expect(requestAction(busy, 'status')).toEqual({ state: busy, effects: [] });
    expect(requestAction(busy, 'schedule')).toEqual({ state: busy, effects: [] });
  });
});

describe('setup tab', () => {
  const status = (login: string | null): SetupStatus => ({
    login,
    autoSync: { claudeHook: false, cursorHook: false, codexNotify: false, geminiHook: false, schedule: false },
    cursorFetch: true,
    graphColors: 'per-model',
  });
  const setup = () => ({ ...state(), setup: status('orcun') });
  const press = (s: AppState, event: InputEvent) => reduce(s, event, null);

  it('opens Projects on 4, Insights on 5 and Setup on 6', () => {
    const on = (char: string) => press(setup(), { type: 'char', char }).state.tab;
    expect([on('1'), on('2'), on('3'), on('4'), on('5'), on('6')]).toEqual(['overview', 'models', 'agents', 'projects', 'insights', 'setup']);
  });

  it('opens on 6, moves within bounds and wraps no further than the list', () => {
    let s = press(setup(), { type: 'char', char: '6' }).state;
    expect(s.tab).toBe('setup');
    expect(s.setupSel).toBe(0);
    s = press(s, { type: 'key', key: 'up' }).state;
    expect(s.setupSel).toBe(0);
    s = press(s, { type: 'key', key: 'down' }).state;
    expect(s.setupSel).toBe(1);
    const count = actionItems(s.setup, s.vm.sources).length;
    for (let i = 0; i < count + 3; i += 1) s = press(s, { type: 'key', key: 'down' }).state;
    expect(s.setupSel).toBe(count - 1);
  });

  it('opens a task item in its box on Enter and asks first for a hook', () => {
    const s = press(setup(), { type: 'char', char: '6' }).state;
    expect(press(s, { type: 'key', key: 'enter' }).effects).toEqual([{ task: 'start', id: 'sync' }]);
    const items = actionItems(s.setup, s.vm.sources);
    const hook = press({ ...s, setupSel: items.findIndex((i) => i.id === 'hook:claude-code') }, { type: 'key', key: 'enter' });
    expect(hook.effects).toEqual([]);
    expect(hook.state.confirm).toMatchObject({ id: 'hook:claude-code' });
  });

  it('jumps from Agents to the Claude Code hook row on h, and not from other tabs', () => {
    const agents = press(setup(), { type: 'char', char: '3' }).state;
    const out = press(agents, { type: 'char', char: 'h' }).state;
    expect(out.tab).toBe('setup');
    expect(actionItems(out.setup, out.vm.sources)[out.setupSel]!.id).toBe('hook:claude-code');
    expect(press(setup(), { type: 'char', char: 'h' }).state.tab).toBe('overview');
  });

  it('selects a row on the first press and requests it on the second; an Agents footer press opens the row', () => {
    const s = press(setup(), { type: 'char', char: '6' }).state;
    const { hits } = renderFrame(s, { theme: 'dark' }, 160, 48, STILL);
    const row = (id: string) => hits.view.hits.find((h) => h.kind === 'action' && h.id === id)!.rect;
    const target = row('readme');
    const click = { type: 'mouse', action: 'press', x: target.x + 5, y: target.y, button: 0 } as const;
    const first = reduce(s, click, hits);
    expect(actionItems(first.state.setup, first.state.vm.sources)[first.state.setupSel]!.id).toBe('readme');
    expect(first.effects).toEqual([]);
    expect(reduce(first.state, click, hits).effects).toEqual([{ task: 'start', id: 'readme' }]);

    const agents = press(setup(), { type: 'char', char: '3' }).state;
    const frame = renderFrame({ ...agents, autoSync: status('orcun').autoSync }, { theme: 'dark' }, 160, 48, STILL);
    const cursor = frame.hits.view.hits.find((h) => h.kind === 'action' && h.id === 'hook:cursor')!;
    const opened = reduce({ ...agents, autoSync: status('orcun').autoSync }, { type: 'mouse', action: 'press', x: cursor.rect.x, y: cursor.rect.y, button: 0 }, frame.hits);
    expect(opened.state.tab).toBe('setup');
    expect(actionItems(opened.state.setup, opened.state.vm.sources)[opened.state.setupSel]!.id).toBe('hook:cursor');
  });
});

describe('limits on the overview', () => {
  const reading = {
    source: 'codex-cli' as const, limitId: 'codex', plan: 'free', origin: 'session-log' as const, readAt: '2026-10-03T10:00:00.000Z', credits: null,
    windows: [{ id: 'primary', minutes: 43200, usedPercent: 6, resetsAt: '2026-10-30T12:00:00.000Z' }],
  };

  it('a press on the missing Claude Code reading opens its Setup row', () => {
    const s = { ...state(), limits: { views: limitViews([reading], new Date('2026-10-03T12:00:00Z')), wrapperOn: false } };
    const frame = renderFrame(s, { theme: 'dark' }, 160, 48, STILL);
    expect(toPlainText(frame.buffer)).toContain('LIMITS');
    const hit = frame.hits.view.hits.find((h) => h.kind === 'action' && h.id === 'claude-limits')!;
    const opened = reduce(s, { type: 'mouse', action: 'press', x: hit.rect.x, y: hit.rect.y, button: 0 }, frame.hits);
    expect(opened.state.tab).toBe('setup');
    expect(actionItems(opened.state.setup, opened.state.vm.sources)[opened.state.setupSel]!.id).toBe('claude-limits');
  });
});

describe('withViewModel', () => {
  it('moves the year view and cursor off the old today when the date rolls over', () => {
    const s = state();
    const next = shiftDate(TODAY, 1);
    const vm = buildViewModel(emptyLedger(), next);
    expect(withViewModel(s, vm).overview).toEqual({ cursor: next, yearEnd: next });
    const browsing = { ...s, overview: { cursor: shiftDate(TODAY, -3), yearEnd: shiftDate(TODAY, -364) } };
    expect(withViewModel(browsing, vm).overview).toEqual(browsing.overview);
    expect(withViewModel(s, buildViewModel(emptyLedger(), TODAY)).overview).toEqual(s.overview);
  });
});

describe('renderFrame', () => {
  it('draws header, tabs, content and status bar', () => {
    const { buffer } = renderFrame(state(), { theme: 'dark' }, 140, 40, STILL);
    const text = toPlainText(buffer);
    for (const s of ['tokengraph', '1 Overview', '5 Insights', 'local only', 'TODAY', 'q quit']) expect(text).toContain(s);
  });

  it('shows key hints for the current tab, with the number keys only on wide screens', () => {
    const bar = (tab: 'overview' | 'models' | 'agents' | 'insights', width: number) =>
      toPlainText(renderFrame({ ...state(), tab }, { theme: 'dark' }, width, 40, STILL).buffer).split('\n').at(-1)!;
    expect(bar('overview', 160)).toContain('1-6 tabs  ←↑↓→ day  [ ] year  t today  c colour  s rescan  : actions  ? help  q quit');
    expect(bar('models', 160)).toContain('1-6 tabs  ↑↓ select  ←→ range  c colour  s rescan  : actions  ? help  q quit');
    expect(bar('agents', 120)).toContain('↑↓ select  ←→ range');
    expect(bar('agents', 120)).not.toContain('1-6 tabs');
    expect(bar('insights', 160)).toContain('1-6 tabs  ←→ hour  s rescan  : actions  ? help  q quit');
    expect(bar('insights', 120)).not.toContain('range');
  });

  it('leaves out whole key hints, lowest value first, instead of cutting one mid-word', () => {
    const projects = '↑↓ select  ←→ range  m merge  n rename  x split  s rescan  : actions  ? help  q quit';
    expect(fitHints(projects, 200)).toBe(projects);
    expect(fitHints(projects, 82)).toBe('↑↓ select  ←→ range  m merge  n rename  x split  : actions  ? help  q quit');
    expect(fitHints(projects, 60)).toBe('↑↓ select  ←→ range  m merge  n rename  ? help  q quit');
    expect(fitHints(projects, 40)).toBe('↑↓ select  ←→ range  ? help  q quit');
    expect(fitHints(projects, 10)).toBe('↑↓ select…');
    const bar = toPlainText(renderFrame({ ...state(), tab: 'projects' }, { theme: 'dark' }, 100, 40, STILL).buffer).split('\n').at(-1)!;
    expect(bar).toContain('? help  q quit');
  });

  it('uses a short mode pill instead of clipping it at 80 columns', () => {
    const header = (mode: string, width: number) =>
      toPlainText(renderFrame({ ...state(), mode }, { theme: 'dark' }, width, 24, STILL).buffer).split('\n')[0]!;
    expect(header('↑ publishing as @orcun', 80)).toContain('↑ @orcun');
    expect(header('↑ publishing as @orcun', 80)).not.toContain('…');
    // Five tabs leave no room for the idle indicator at 80 columns, so the pill keeps its full text.
    expect(header('local only', 80)).toMatch(/local only\s*$/);
    expect(header('↑ publishing as @orcun', 140)).toContain('↑ publishing as @orcun');
  });

  it('shows a toast in the status bar for four seconds, replacing the scan text', () => {
    const toast = (tone: 'good' | 'bad') => ({ ...state(), scan: { ...state().scan, lastScanAt: 0 }, toast: { text: 'Hook installed.', tone, at: 0 } });
    const bar = (s: ReturnType<typeof state>, now: number) =>
      toPlainText(renderFrame(s, { theme: 'dark' }, 120, 30, { ...STILL, now }).buffer).split('\n').at(-1)!;
    expect(bar(toast('good'), 1000)).toContain('✓ Hook installed.');
    expect(bar(toast('good'), 1000)).not.toContain('scanned');
    expect(bar(toast('bad'), 1000)).toContain('✗ Hook installed.');
    expect(bar(toast('good'), 4000)).not.toContain('Hook installed.');
    expect(bar(toast('good'), 4000)).toContain('scanned');
  });

  it('asks for a bigger window below 80×24 and survives absurd sizes', () => {
    expect(toPlainText(renderFrame(state(), { theme: 'dark' }, 60, 20, STILL).buffer)).toContain('80');
    expect(() => renderFrame(state(), { theme: 'light' }, 300, 80, STILL)).not.toThrow();
    expect(() => renderFrame(state(), { theme: 'dark' }, 1, 1, STILL)).not.toThrow();
  });
});

function fakeTerminal() {
  const writes: string[] = [];
  let input: (events: unknown[]) => void = () => {};
  let restored = 0;
  const calls: string[] = [];
  return {
    writes, calls, get restored() { return restored; },
    send: (events: unknown[]) => input(events),
    terminal: {
      width: 120, height: 36,
      write: (s: string) => void writes.push(s),
      onInput: (fn: (events: unknown[]) => void) => void (input = fn),
      onResize: () => {},
      restore: () => void (restored += 1),
    },
  };
}

const NO_AUTO_SYNC = async () => ({ claudeHook: null, cursorHook: null, codexNotify: null, geminiHook: null, schedule: null });

describe('runApp', () => {
  it('loads the limit readings at start and after every scan', async () => {
    const term = fakeTerminal();
    let loads = 0;
    let last = '';
    const done = runApp({
      onFrame: (buffer) => void (last = toPlainText(buffer)),
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => emptyLedger(),
      scan: async (ledger) => ({
        ledger: mergeUsage(ledger, 'codex-cli', [{ date: TODAY, model: 'gpt-5', pricingTier: 'standard', counts: c(500) }]),
        results: [], failures: [], detected: ['codex'],
      }),
      persist: async () => 'saved',
      modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      limits: async () => (loads += 1, { views: [], wrapperOn: false }),
      setTimer: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); return () => clearTimeout(t); },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(loads).toBeGreaterThanOrEqual(2);
    expect(last).toContain('turn on in Setup');
    term.send([{ type: 'char', char: 'q' }]);
    expect(await done).toBe(0);
  });

  it('keeps the merge in memory when the ledger is busy, then quits cleanly', async () => {
    const term = fakeTerminal();
    let persisted = 0;
    let last = '';
    const done = runApp({
      onFrame: (buffer) => void (last = toPlainText(buffer)),
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => emptyLedger(),
      scan: async (ledger) => ({
        ledger: mergeUsage(ledger, 'codex-cli', [{ date: TODAY, model: 'gpt-5', pricingTier: 'standard', counts: c(500) }]),
        results: [], failures: [], detected: ['codex'],
      }),
      persist: async () => (persisted += 1, 'busy'),
      modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      setTimer: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); return () => clearTimeout(t); },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(persisted).toBe(1);
    expect(last).toContain('ledger busy');
    term.send([{ type: 'char', char: 'q' }]);
    expect(await done).toBe(0);
    expect(term.restored).toBe(1);
  });

  it('restores the terminal when loading fails', async () => {
    const term = fakeTerminal();
    const done = runApp({
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => { throw new Error('ledger exploded'); },
      scan: async (l) => ({ ledger: l, results: [], failures: [], detected: [] }),
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    });
    await expect(done).rejects.toThrow('ledger exploded');
    expect(term.restored).toBe(1);
  });

  it('does not quit on Alt+key, but quits on a lone Escape', async () => {
    const term = fakeTerminal();
    let settled = false;
    const done = runApp({
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => emptyLedger(),
      scan: async (l) => ({ ledger: l, results: [], failures: [], detected: [] }),
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    });
    void done.then(() => void (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    term.send([{ type: 'key', key: 'escape' }, { type: 'char', char: 'x' }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    term.send([{ type: 'key', key: 'escape' }]);
    expect(await done).toBe(0);
  });

  it('shows a note when an adapter could not be read', async () => {
    const term = fakeTerminal();
    let last = '';
    const done = runApp({
      onFrame: (buffer) => void (last = toPlainText(buffer)),
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => emptyLedger(),
      scan: async (l) => ({ ledger: l, results: [], failures: [{ adapter: 'codex-cli', message: 'boom' }], detected: ['codex'] }),
      persist: async () => 'saved', modeLabel: async () => { throw new Error('no config'); }, autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      setTimer: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); return () => clearTimeout(t); },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(last).toContain('codex-cli could not be read');
    expect(last).toContain('local only');
    term.send([{ type: 'char', char: 'q' }]);
    expect(await done).toBe(0);
  });

  it('follows midnight: a rescan on a new day moves the cursor to the new today', async () => {
    const term = fakeTerminal();
    let day = TODAY;
    let last = '';
    const done = runApp({
      onFrame: (buffer) => void (last = toPlainText(buffer)),
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => day,
      loadLedger: async () => mergeUsage(emptyLedger(), 'claude-code', [{ date: TODAY, model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(1000) }]),
      scan: async (l) => ({ ledger: l, results: [], failures: [], detected: [] }),
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      setTimer: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); return () => clearTimeout(t); },
    });
    await new Promise((r) => setTimeout(r, 30));
    day = shiftDate(TODAY, 1);
    term.send([{ type: 'char', char: 's' }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(last).toContain('Sun 4 Oct 2026');
    term.send([{ type: 'char', char: 'q' }]);
    expect(await done).toBe(0);
  });

  it('reports a paint error in the scan progress callback instead of recording an adapter failure', async () => {
    const term = fakeTerminal();
    let armed = false;
    let swallowed = false;
    const done = runApp({
      onFrame: () => { if (armed) throw new Error('paint exploded'); },
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => emptyLedger(),
      scan: async (l, _since, onProgress) => {
        armed = true;
        try {
          onProgress({ adapter: 'codex-cli', state: 'scanning' } as never);
        } catch {
          swallowed = true; // collectLocal would record this as an adapter failure
        }
        return { ledger: l, results: [], failures: [], detected: [] };
      },
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    });
    await expect(done).rejects.toThrow('paint exploded');
    expect(swallowed).toBe(false);
    expect(term.restored).toBe(1);
  });

  it('waits for an in-flight persist before resolving a quit', async () => {
    const term = fakeTerminal();
    let finishPersist: () => void = () => {};
    let persistStarted = false;
    let settled = false;
    const done = runApp({
      terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
      clock: () => 0, today: () => TODAY,
      loadLedger: async () => emptyLedger(),
      scan: async (l) => ({ ledger: l, results: [], failures: [], detected: [] }),
      persist: () => new Promise<'saved'>((resolve) => { persistStarted = true; finishPersist = () => resolve('saved'); }),
      modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    });
    void done.then(() => void (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(persistStarted).toBe(true);
    term.send([{ type: 'char', char: 'q' }]);
    expect(term.restored).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    finishPersist();
    expect(await done).toBe(0);
  });

  it('gives up waiting for a stuck persist after two seconds', async () => {
    vi.useFakeTimers();
    try {
      const term = fakeTerminal();
      let started = false;
      const done = runApp({
        terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
        clock: () => 0, today: () => TODAY,
        loadLedger: async () => emptyLedger(),
        scan: async (l) => ({ ledger: l, results: [], failures: [], detected: [] }),
        persist: () => { started = true; return new Promise<'saved'>(() => {}); },
        modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
        setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(started).toBe(true);
      term.send([{ type: 'char', char: 'q' }]);
      await vi.advanceTimersByTimeAsync(2100);
      expect(await done).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('actions', () => {
    const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
    const SETUP = { login: null, autoSync: null, cursorFetch: null, graphColors: 'model' as const };

    it('picks up a project name given in another terminal on the next scan', async () => {
      const folder = '/w/alpha';
      const usage = { date: TODAY, model: 'claude-opus-4-8', pricingTier: 'standard' as const, counts: { inputTokens: 5000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 } };
      const names: { value: Record<string, string> } = { value: {} };
      const app = start({
        loadLedger: async () => mergeProjects(mergeUsage(emptyLedger(), 'claude-code', [usage]), 'claude-code', [{ ...usage, folder }]),
        projectNames: async () => names.value,
      });
      await wait();
      app.term.send([{ type: 'char', char: '4' }]);
      await wait();
      expect(app.text()).toContain('alpha');
      names.value = { [folder]: 'renamed' };
      app.term.send([{ type: 'char', char: 's' }]);
      await wait(60);
      expect(app.text()).toContain('renamed');
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    describe('updates', () => {
      const WITH_UPDATE = { ...SETUP, update: { current: '0.1.1', latest: '0.2.0' } };

      it('shows a version the check finds after the view has opened, without ever waiting for it', async () => {
        let answer: () => void = () => {};
        const status = { value: SETUP as unknown };
        const app = start({
          setupStatus: vi.fn(async () => status.value),
          checkForUpdate: () => new Promise<void>((resolve) => { answer = resolve; }),
        });
        await wait();
        expect(app.text()).toContain('Overview');
        expect(app.text()).not.toContain('0.2.0 is out');
        status.value = WITH_UPDATE;
        answer();
        await wait();
        expect(app.text()).toContain('0.2.0 is out · u to update');
        app.term.send([{ type: 'char', char: 'q' }]);
        expect(await app.done).toBe(0);
      });

      it('keeps quiet and keeps working when the check fails', async () => {
        const app = start({ checkForUpdate: async () => { throw new Error('offline'); } });
        await wait();
        expect(app.text()).toContain('Overview');
        expect(app.text()).not.toContain('offline');
        app.term.send([{ type: 'char', char: 'q' }]);
        expect(await app.done).toBe(0);
      });

      it('u opens the update in the task box when a version is waiting', async () => {
        const app = start({ setupStatus: vi.fn(async () => WITH_UPDATE) });
        await wait();
        app.term.send([{ type: 'char', char: 'u' }]);
        await wait(60);
        expect(app.tasks).toEqual(['update']);
        expect(app.text()).toContain('UPDATE TO 0.2.0');
        app.emit({ kind: 'done', code: 0, after: 'reload', cancelled: false });
        await wait();
        app.term.send([{ type: 'key', key: 'enter' }]);
        await wait();
        expect(app.text()).not.toContain('UPDATE TO 0.2.0');
        app.term.send([{ type: 'char', char: 'q' }]);
        expect(await app.done).toBe(0);
      });

      it('u does nothing while no update is known', async () => {
        const app = start();
        await wait();
        app.term.send([{ type: 'char', char: 'u' }]);
        await wait();
        expect(app.runAction).not.toHaveBeenCalled();
        app.term.send([{ type: 'char', char: 'q' }]);
        expect(await app.done).toBe(0);
      });

      it('leaves the view when the box of a finished update closes instead of going on with the old code', async () => {
        let settled = false;
        const app = start({ setupStatus: vi.fn(async () => WITH_UPDATE) });
        void app.done.then(() => void (settled = true));
        await wait();
        app.term.send([{ type: 'char', char: 'u' }]);
        await wait();
        app.emit({ kind: 'line', text: 'Updated tokengraph to 0.2.0.', tone: 'out' });
        app.emit({ kind: 'done', code: 0, after: 'restart', cancelled: false });
        await wait();
        expect(app.text()).toContain('starts again when you close this box');
        expect(app.text()).toContain('enter restart tokengraph');
        expect(settled).toBe(false);
        app.term.send([{ type: 'key', key: 'enter' }]);
        expect(await app.done).toBe(0);
        expect(app.term.restored).toBe(1);
      });
    });

    function start(over: Record<string, unknown> = {}) {
      const term = fakeTerminal();
      let last = '';
      let request: (id: string) => void = () => {};
      const runAction = vi.fn(async (id: string) => (term.calls.push(`run:${id}`), { code: 0, lines: ['', 'Done it.', ''] }));
      const setupStatus = vi.fn(async () => SETUP);
      const tasks: string[] = [];
      const session = { answers: [] as unknown[], cancels: 0, stops: 0 };
      let emit: (event: TaskEvent) => void = () => {};
      const startTask = vi.fn((id: string, _status: unknown, onEvent: (event: TaskEvent) => void) => {
        tasks.push(id);
        emit = onEvent;
        onEvent({ kind: 'started' });
        return { answer: (value: unknown) => void session.answers.push(value), cancel: () => void (session.cancels += 1), stop: () => void (session.stops += 1) };
      });
      const deps = {
        onFrame: (buffer: never) => void (last = toPlainText(buffer)),
        onReady: (controls: { request: (id: string) => void }) => void (request = controls.request),
        terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
        clock: () => 0, today: () => TODAY,
        loadLedger: async () => emptyLedger(),
        scan: async (l: never) => ({ ledger: l, results: [], failures: [], detected: [] }),
        persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC, checkForUpdate: async () => {}, projectNames: async () => ({}),
        editProjects: async () => ({ ok: false, error: 'not in this test' }),
        setTimer: (fn: () => void, ms: number) => { const t = setTimeout(fn, Math.min(ms, 5)); return () => clearTimeout(t); },
        setupStatus, runAction, startTask,
        ...over,
      };
      const done = runApp(deps as never);
      return {
        term, done, tasks, session, runAction: deps.runAction as typeof runAction, startTask: deps.startTask as typeof startTask, setupStatus,
        emit: (event: TaskEvent) => emit(event), request: (id: string) => request(id), text: () => last,
      };
    }

    /** A clock a second further on at every read, so keys always come well after the question they answer. */
    const ticking = () => { let t = 0; return () => (t += 1000); };

    /** The real task session over `run`, as the view wires it. */
    const realTask = (run: TaskRun) => (_id: string, _status: unknown, emit: (event: TaskEvent) => void) => startTaskSession(run, emit);

    it('runs an inline action after the confirmation, toasts its last line and reloads the setup status', async () => {
      const app = start();
      await wait();
      const loads = app.setupStatus.mock.calls.length;
      app.request('hook:claude-code');
      expect(app.runAction).not.toHaveBeenCalled();
      app.term.send([{ type: 'char', char: 'y' }]);
      await wait();
      expect(app.runAction).toHaveBeenCalledWith('hook:claude-code', SETUP);
      expect(app.text()).toContain('✓ Done it.');
      expect(app.setupStatus.mock.calls.length).toBeGreaterThan(loads);
      expect(app.term.calls).toEqual(['run:hook:claude-code']);
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('runs a task action in a box inside the view: output as it is printed, a question, done, then Enter reloads', async () => {
      let answer: (value: boolean) => void = () => {};
      const asked = new Promise<boolean>((resolve) => { answer = resolve; });
      const loads = { ledger: 0 };
      const out = vi.spyOn(process.stdout, 'write');
      const err = vi.spyOn(process.stderr, 'write');
      const app = start({
        clock: ticking(),
        loadLedger: async () => (loads.ledger += 1, emptyLedger()),
        startTask: realTask(async () => {
          console.log('\x1b[1mAccount\x1b[22m  @octocat');
          const yes = await askYesNo('Keep going?', { defaultYes: false });
          answer(yes);
          console.error('One warning.');
          return { code: 0 };
        }),
      });
      try {
        await wait();
        app.term.send([{ type: 'char', char: '6' }]);
        app.request('status');
        await wait();
        expect(app.text()).toContain('SHOW STATUS');
        expect(app.text()).toContain('Account  @octocat');
        expect(app.text()).toContain('Keep going?  [y/N]');
        expect(app.text()).not.toContain('q quit'); // the view's hints step aside for the box's keys
        app.term.send([{ type: 'char', char: 'q' }]); // belongs to the box: the view stays open
        app.term.send([{ type: 'char', char: 'y' }]);
        expect(await asked).toBe(true);
        await wait();
        expect(app.text()).toContain('Keep going? Yes');
        expect(app.text()).toContain('One warning.');
        expect(app.text()).toContain('✓ Done');
        expect(app.text()).toContain('enter close');
        expect(out).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
        const before = loads.ledger;
        app.term.send([{ type: 'key', key: 'enter' }]);
        await wait();
        expect(app.text()).not.toContain('SHOW STATUS');
        expect(app.text()).toContain('Show status');
        expect(loads.ledger).toBeGreaterThan(before);
        expect(app.term.restored).toBe(0);
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('takes a typed path in the box, and Esc answers a question as cancel', async () => {
      const answers: string[] = [];
      const app = start({
        clock: ticking(),
        startTask: realTask(async () => {
          answers.push(await askText('Path to the CSV:'));
          answers.push(await askText('Again:'));
          return { code: 0 };
        }),
      });
      await wait();
      app.request('import-cursor');
      await wait();
      for (const char of '/tmp/a.csv') app.term.send([{ type: 'char', char }]);
      app.term.send([{ type: 'key', key: 'left' }, { type: 'key', key: 'backspace' }]);
      await wait();
      expect(app.text()).toContain('› /tmp/a.cv');
      app.term.send([{ type: 'key', key: 'enter' }]);
      await wait();
      app.term.send([{ type: 'char', char: 'x' }]);
      app.term.send([{ type: 'key', key: 'escape' }]);
      await wait();
      expect(answers).toEqual(['/tmp/a.cv', '']);
      expect(app.text()).toContain('Again: (cancelled)');
      app.term.send([{ type: 'key', key: 'escape' }]);
      await wait();
      expect(app.text()).not.toContain('IMPORT A CURSOR USAGE CSV');
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('keeps a quit choice of uninstall: closing its box ends the view', async () => {
      const app = start();
      await wait();
      app.request('uninstall');
      await wait();
      app.emit({ kind: 'done', code: 0, after: 'quit', cancelled: false });
      await wait();
      expect(app.text()).toContain('tokengraph closes with this box');
      expect(app.text()).toContain('enter quit tokengraph');
      app.term.send([{ type: 'key', key: 'escape' }]);
      expect(await app.done).toBe(0);
      expect(app.session.stops).toBe(1);
    });

    it('makes story cards in a box inside the view: period, cards, QR, s saves and Esc returns to Setup', async () => {
      const story: string[] = [];
      let emit: (event: StoryEvent) => void = () => {};
      const startStory = vi.fn((range: string, onEvent: (event: StoryEvent) => void) => {
        emit = onEvent;
        story.push(`start:${range}`);
        return { save: () => void story.push('save'), stop: () => void story.push('stop') };
      });
      const app = start({ startStory });
      await wait();
      app.term.send([{ type: 'char', char: '6' }]);
      app.request('story');
      await wait();
      expect(app.text()).toContain('Which period should the cards cover?');
      app.term.send([{ type: 'key', key: 'down' }, { type: 'key', key: 'enter' }]);
      await wait();
      expect(story).toEqual(['start:7d']);
      const url = 'http://192.168.1.20:50123/AbCdEfGhIjKlMnOpQrStUv/';
      emit({ kind: 'loaded', handle: 'octocat', empty: false });
      for (const id of ['skyline', 'receipt', 'sticker'] as const) emit({ kind: 'drawn', id });
      emit({ kind: 'sharing', url, qr: qrMatrix(url) });
      await wait();
      expect(app.text()).toContain("Scan with your phone's camera");
      app.term.send([{ type: 'char', char: 's' }]);
      app.term.send([{ type: 'char', char: 'q' }]); // belongs to the box: the view stays open
      await wait();
      expect(story).toEqual(['start:7d', 'save']);
      app.term.send([{ type: 'key', key: 'escape' }]);
      await wait();
      expect(story).toEqual(['start:7d', 'save', 'stop']);
      emit({ kind: 'phone' }); // late events from the stopped session change nothing
      await wait();
      expect(app.text()).not.toContain('STORY CARDS');
      expect(app.text()).toContain('Make story cards');
      expect(app.term.calls).not.toContain('suspend');
      expect(app.runAction).not.toHaveBeenCalled();
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('starts no session when the story box closes before a period is chosen', async () => {
      const startStory = vi.fn();
      const app = start({ startStory });
      await wait();
      app.request('story');
      await wait();
      app.term.send([{ type: 'key', key: 'escape' }]);
      await wait();
      expect(startStory).not.toHaveBeenCalled();
      expect(app.text()).not.toContain('STORY CARDS');
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('shows a command that throws as a failed box, and Ctrl-C does not quit while it runs', async () => {
      let fail: (error: Error) => void = () => {};
      let settled = false;
      const app = start({ startTask: realTask(() => new Promise((_resolve, reject) => { fail = reject; })) });
      void app.done.then(() => void (settled = true));
      await wait();
      app.request('status');
      await wait();
      app.term.send([{ type: 'ctrl', char: 'c' }]);
      await wait();
      expect(settled).toBe(false);
      expect(app.text()).toContain('Press Ctrl-C again to quit tokengraph.');
      fail(new Error('command exploded'));
      await wait();
      expect(app.text()).toContain('command exploded');
      expect(app.text()).toContain('✗ Failed (exit code 1)');
      app.term.send([{ type: 'ctrl', char: 'c' }]); // closes the finished box, still no quit
      await wait();
      expect(settled).toBe(false);
      expect(app.text()).not.toContain('SHOW STATUS');
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('quits tokengraph on a second Ctrl-C within two seconds while a command hangs, putting everything back', async () => {
      let now = 0;
      const log = console.log;
      const app = start({
        clock: () => now,
        startTask: realTask(async () => {
          console.log('Installing…');
          return new Promise(() => {}); // npm that never returns
        }),
      });
      await wait();
      app.request('update');
      await wait();
      expect(console.log).not.toBe(log);
      now = 10_000;
      app.term.send([{ type: 'ctrl', char: 'c' }]);
      await wait();
      expect(app.text()).toContain('Press Ctrl-C again to quit tokengraph.');
      now = 13_000; // too late: arms again
      app.term.send([{ type: 'ctrl', char: 'c' }]);
      await wait();
      expect(app.term.restored).toBe(0);
      now = 14_500;
      app.term.send([{ type: 'ctrl', char: 'c' }]);
      expect(await app.done).toBe(130);
      expect(app.term.restored).toBe(1);
      expect(console.log).toBe(log);
      // The prompts answer on the terminal again (none under vitest, so the default comes back at once).
      expect(await askYesNo('Still the box?', { defaultYes: false })).toBe(false);
    });

    it('lets the person leave a box that waits for a scan that never ends', async () => {
      let scans = 0;
      const app = start({
        scan: () => (scans += 1, new Promise(() => {})),
      });
      await wait();
      app.request('status');
      await wait();
      expect(app.text()).toContain('Waiting for the scan to finish…');
      expect(app.text()).toContain('esc close');
      app.term.send([{ type: 'key', key: 'escape' }]);
      await wait();
      expect(app.text()).not.toContain('SHOW STATUS');
      expect(app.startTask).not.toHaveBeenCalled();
      // The view is usable again: another action can be asked for, and q quits.
      app.request('export-csv');
      await wait();
      expect(app.text()).toContain('EXPORT AS CSV');
      app.term.send([{ type: 'ctrl', char: 'c' }]);
      await wait();
      expect(app.text()).not.toContain('EXPORT AS CSV');
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
      expect(app.startTask).not.toHaveBeenCalled();
      expect(scans).toBe(1);
    });

    it('draws a burst of output lines in one frame', async () => {
      let frames = 0;
      const app = start({
        onFrame: () => void (frames += 1),
        // Only zero-delay timers run, so the spinner and the clock tick add no frames of their own.
        setTimer: (fn: () => void, ms: number) => { if (ms > 0) return () => {}; const t = setTimeout(fn, 0); return () => clearTimeout(t); },
      });
      await wait();
      app.request('status');
      await wait();
      const before = frames;
      for (let i = 0; i < 200; i += 1) app.emit({ kind: 'line', text: `line ${i}`, tone: 'out' });
      await wait();
      expect(frames - before).toBe(1);
      app.emit({ kind: 'done', code: 0, after: 'reload', cancelled: false });
      await wait();
      app.term.send([{ type: 'key', key: 'enter' }]);
      await wait();
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('toasts the first line of a successful inline action and the last of a failing one', async () => {
      const ok = start({ runAction: vi.fn(async () => ({ code: 0, lines: ['Installed the hook.', '', 'If SessionEnd is not supported, try X.'] })) });
      await wait();
      ok.request('schedule');
      ok.term.send([{ type: 'char', char: 'y' }]);
      await wait();
      expect(ok.text()).toContain('✓ Installed the hook.');
      expect(ok.text()).not.toContain('If SessionEnd');
      ok.term.send([{ type: 'char', char: 'q' }]);
      await ok.done;
      const bad = start({ runAction: vi.fn(async () => ({ code: 1, lines: ['Trying.', 'Could not write settings.'] })) });
      await wait();
      bad.request('schedule');
      bad.term.send([{ type: 'char', char: 'y' }]);
      await wait();
      expect(bad.text()).toContain('✗ Could not write settings.');
      bad.term.send([{ type: 'char', char: 'q' }]);
      await bad.done;
    });

    it('cancels a command that says it can stop, and scrolls its output', async () => {
      const app = start();
      await wait();
      app.request('login');
      await wait();
      for (let i = 1; i <= 80; i += 1) app.emit({ kind: 'line', text: `line ${i}`, tone: 'out' });
      app.emit({ kind: 'cancellable', value: true });
      await wait();
      expect(app.text()).toContain('line 80');
      expect(app.text()).toContain('esc cancel');
      app.term.send([{ type: 'key', key: 'home' }]);
      await wait();
      expect(app.text()).toMatch(/line 1\s/);
      expect(app.text()).not.toContain('line 80');
      app.term.send([{ type: 'key', key: 'end' }]);
      await wait();
      expect(app.text()).toContain('line 80');
      app.term.send([{ type: 'key', key: 'escape' }]);
      await wait();
      expect(app.session.cancels).toBe(1);
      expect(app.text()).toContain('Cancelling…');
      app.emit({ kind: 'line', text: 'Login cancelled.', tone: 'err' });
      app.emit({ kind: 'done', code: 1, after: 'reload', cancelled: true });
      await wait();
      expect(app.text()).toContain('Login cancelled.');
      expect(app.text()).toContain('– Cancelled');
      expect(app.text()).not.toContain('Failed');
      app.term.send([{ type: 'key', key: 'enter' }]);
      await wait();
      expect(app.text()).not.toContain('CONNECT GITHUB');
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('shows a failing exit code as a red toast', async () => {
      const app = start({ runAction: vi.fn(async () => ({ code: 1, lines: ['Nope.'] })) });
      await wait();
      app.request('schedule');
      app.term.send([{ type: 'char', char: 'y' }]);
      await wait();
      expect(app.text()).toContain('✗ Nope.');
      app.term.send([{ type: 'char', char: 'q' }]);
      await app.done;
    });

    it('waits for a scan that is still running instead of starting the action', async () => {
      let finishScan: () => void = () => {};
      let scans = 0;
      const app = start({
        scan: (l: never) => new Promise((resolve) => {
          scans += 1;
          // Only the first scan hangs; the one after the action must not.
          if (scans > 1) return resolve({ ledger: l, results: [], failures: [], detected: [] });
          finishScan = () => resolve({ ledger: l, results: [], failures: [], detected: [] });
        }),
      });
      await wait();
      app.request('status');
      await wait();
      expect(app.startTask).not.toHaveBeenCalled();
      expect(app.text()).toContain('Waiting for the scan to finish…');
      finishScan();
      await wait(60);
      expect(app.tasks).toEqual(['status']);
      expect(app.text()).not.toContain('Waiting for the scan to finish…');
      app.emit({ kind: 'done', code: 0, after: 'reload', cancelled: false });
      await wait();
      app.term.send([{ type: 'key', key: 'enter' }]);
      await wait();
      expect(scans).toBe(2); // the view scans again once the box is closed
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('does not start a second action while one runs', async () => {
      let release: () => void = () => {};
      const app = start({ runAction: vi.fn(() => new Promise((resolve) => { release = () => resolve({ code: 0, lines: ['ok'] }); })) });
      await wait();
      app.request('hook:cursor');
      app.term.send([{ type: 'char', char: 'y' }]);
      await wait();
      app.request('schedule');
      app.term.send([{ type: 'char', char: 'y' }]);
      await wait();
      expect(app.runAction).toHaveBeenCalledTimes(1);
      release();
      await wait();
      app.term.send([{ type: 'char', char: 'q' }]);
      await app.done;
    });
  });
});
