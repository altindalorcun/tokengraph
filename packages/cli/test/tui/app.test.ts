import { describe, expect, it, vi } from 'vitest';
import { emptyLedger, mergeUsage } from '../../src/ledger.js';
import { STILL } from '../../src/tui/animate.js';
import { initialState, reduce, renderFrame, requestAction, runApp, withViewModel } from '../../src/tui/app.js';
import { buildViewModel, shiftDate } from '../../src/tui/model.js';
import { toPlainText } from '../../src/tui/screen.js';
import { actionItems, type SetupStatus } from '../../src/tui/actions.js';
import type { AppState } from '../../src/tui/app-state.js';
import type { InputEvent } from '../../src/tui/input.js';

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
    expect(requestAction(state(), 'status')).toMatchObject({ effects: [{ run: 'status' }] });
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

  it('opens on 5, moves within bounds and wraps no further than the list', () => {
    let s = press(setup(), { type: 'char', char: '5' }).state;
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

  it('runs a screen item on Enter and asks first for a hook', () => {
    const s = press(setup(), { type: 'char', char: '5' }).state;
    expect(press(s, { type: 'key', key: 'enter' }).effects).toEqual([{ run: 'sync' }]);
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
    const s = press(setup(), { type: 'char', char: '5' }).state;
    const { hits } = renderFrame(s, { theme: 'dark' }, 160, 48, STILL);
    const row = (id: string) => hits.view.hits.find((h) => h.kind === 'action' && h.id === id)!.rect;
    const target = row('readme');
    const click = { type: 'mouse', action: 'press', x: target.x + 5, y: target.y, button: 0 } as const;
    const first = reduce(s, click, hits);
    expect(actionItems(first.state.setup, first.state.vm.sources)[first.state.setupSel]!.id).toBe('readme');
    expect(first.effects).toEqual([]);
    expect(reduce(first.state, click, hits).effects).toEqual([{ run: 'readme' }]);

    const agents = press(setup(), { type: 'char', char: '3' }).state;
    const frame = renderFrame({ ...agents, autoSync: status('orcun').autoSync }, { theme: 'dark' }, 160, 48, STILL);
    const cursor = frame.hits.view.hits.find((h) => h.kind === 'action' && h.id === 'hook:cursor')!;
    const opened = reduce({ ...agents, autoSync: status('orcun').autoSync }, { type: 'mouse', action: 'press', x: cursor.rect.x, y: cursor.rect.y, button: 0 }, frame.hits);
    expect(opened.state.tab).toBe('setup');
    expect(actionItems(opened.state.setup, opened.state.vm.sources)[opened.state.setupSel]!.id).toBe('hook:cursor');
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
    for (const s of ['tokengraph', '1 Overview', '4 Insights', 'local only', 'TODAY', 'q quit']) expect(text).toContain(s);
  });

  it('shows key hints for the current tab, with the number keys only on wide screens', () => {
    const bar = (tab: 'overview' | 'models' | 'agents' | 'insights', width: number) =>
      toPlainText(renderFrame({ ...state(), tab }, { theme: 'dark' }, width, 40, STILL).buffer).split('\n').at(-1)!;
    expect(bar('overview', 160)).toContain('1-5 tabs  ←↑↓→ day  [ ] year  t today  c colour  s rescan  : actions  ? help  q quit');
    expect(bar('models', 160)).toContain('1-5 tabs  ↑↓ select  ←→ range  c colour  s rescan  : actions  ? help  q quit');
    expect(bar('agents', 120)).toContain('↑↓ select  ←→ range');
    expect(bar('agents', 120)).not.toContain('1-5 tabs');
    expect(bar('insights', 160)).toContain('1-5 tabs  Tab next tab  s rescan  : actions  ? help  q quit');
    expect(bar('insights', 120)).not.toContain('range');
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
      suspend: () => void calls.push('suspend'),
      resume: () => void calls.push('resume'),
    },
  };
}

const NO_AUTO_SYNC = async () => ({ claudeHook: null, cursorHook: null, codexNotify: null, geminiHook: null, schedule: null });

describe('runApp', () => {
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
      modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
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
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
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
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
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
      persist: async () => 'saved', modeLabel: async () => { throw new Error('no config'); }, autoSync: NO_AUTO_SYNC,
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
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
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
      persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
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
      modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
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
        modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
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

    function start(over: Record<string, unknown> = {}) {
      const term = fakeTerminal();
      let last = '';
      let request: (id: string) => void = () => {};
      const runAction = vi.fn(async (id: string, kind: string) => (term.calls.push(`run:${id}:${kind}`), { code: 0, lines: ['', 'Done it.', ''] }));
      const setupStatus = vi.fn(async () => SETUP);
      const writes: string[] = [];
      const deps = {
        onFrame: (buffer: never) => void (last = toPlainText(buffer)),
        onReady: (controls: { request: (id: string) => void }) => void (request = controls.request),
        terminal: term.terminal as never, depth: 'none', theme: 'dark', motion: false, live: false,
        clock: () => 0, today: () => TODAY,
        loadLedger: async () => emptyLedger(),
        scan: async (l: never) => ({ ledger: l, results: [], failures: [], detected: [] }),
        persist: async () => 'saved', modeLabel: async () => 'local only', autoSync: NO_AUTO_SYNC,
        setTimer: (fn: () => void, ms: number) => { const t = setTimeout(fn, Math.min(ms, 5)); return () => clearTimeout(t); },
        setupStatus, runAction,
        waitForEnter: async () => void term.calls.push('enter'),
        write: (t: string) => void writes.push(t),
        ...over,
      };
      const done = runApp(deps as never);
      return { term, done, runAction: deps.runAction as typeof runAction, setupStatus, writes, request: (id: string) => request(id), text: () => last };
    }

    it('runs an inline action after the confirmation, toasts its last line and reloads the setup status', async () => {
      const app = start();
      await wait();
      const loads = app.setupStatus.mock.calls.length;
      app.request('hook:claude-code');
      expect(app.runAction).not.toHaveBeenCalled();
      app.term.send([{ type: 'char', char: 'y' }]);
      await wait();
      expect(app.runAction).toHaveBeenCalledWith('hook:claude-code', 'inline', SETUP);
      expect(app.text()).toContain('✓ Done it.');
      expect(app.setupStatus.mock.calls.length).toBeGreaterThan(loads);
      expect(app.term.calls).toEqual([expect.stringContaining('run:hook:claude-code:inline')]);
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('suspends the terminal around a screen action and waits for Enter before resuming', async () => {
      const app = start();
      await wait();
      app.request('status');
      await wait();
      expect(app.term.calls).toEqual(['suspend', 'run:status:screen', 'enter', 'resume']);
      expect(app.writes.join('')).toContain('› Show status');
      expect(app.writes.join('')).toContain('Press Enter to return to tokengraph.');
      app.term.send([{ type: 'char', char: 'q' }]);
      expect(await app.done).toBe(0);
    });

    it('resumes the terminal and shows a red toast when a screen action throws', async () => {
      const app = start({
        runAction: vi.fn(async () => { throw new Error('command exploded'); }),
      });
      await wait();
      app.request('status');
      await wait();
      expect(app.term.calls).toEqual(['suspend', 'enter', 'resume']);
      expect(app.text()).toContain('✗ command exploded');
      app.request('status');
      await wait();
      expect(app.term.calls.filter((c) => c === 'resume')).toHaveLength(2);
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

    it('writes nothing while a screen action runs, then redraws; typed-ahead input after resume is ignored', async () => {
      let release: () => void = () => {};
      let resize: () => void = () => {};
      const app = start({
        runAction: vi.fn(() => new Promise((resolve) => { release = () => resolve({ code: 0, lines: [] }); })),
        setTimer: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms > 100 ? Math.min(ms, 20) : ms); return () => clearTimeout(t); },
      });
      (app.term.terminal as { onResize: (fn: () => void) => void }).onResize = (fn) => void (resize = fn);
      await wait();
      app.request('status');
      await wait();
      expect(app.term.calls).toEqual(['suspend']);
      const before = app.term.writes.length;
      resize();
      await wait(80);
      expect(app.term.writes.length).toBe(before);
      // A key typed during the command and delivered on resume must not reach the view.
      const terminal = app.term.terminal as { resume: () => void; write: (s: string) => void };
      const resume = terminal.resume;
      terminal.resume = () => { resume(); app.term.send([{ type: 'char', char: 'q' }]); };
      release();
      await wait(10);
      expect(app.term.calls).toEqual(['suspend', 'enter', 'resume']);
      expect(app.term.writes.length).toBeGreaterThan(before);
      await wait(60);
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
      expect(app.runAction).not.toHaveBeenCalled();
      expect(app.term.calls).toEqual([]);
      finishScan();
      await wait(60);
      expect(app.runAction).toHaveBeenCalledTimes(1);
      expect(app.term.calls).toEqual(['suspend', 'run:status:screen', 'enter', 'resume']);
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
