import { describe, expect, it, vi } from 'vitest';
import { emptyLedger, mergeUsage } from '../../src/ledger.js';
import { STILL } from '../../src/tui/animate.js';
import { initialState, reduce, renderFrame, runApp, withViewModel } from '../../src/tui/app.js';
import { buildViewModel, shiftDate } from '../../src/tui/model.js';
import { toPlainText } from '../../src/tui/screen.js';

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
    expect(bar('overview', 160)).toContain('1-4 tabs  ←↑↓→ day  [ ] year  t today  c colour  s rescan  ? help  q quit');
    expect(bar('models', 160)).toContain('1-4 tabs  ↑↓ select  ←→ range  c colour  s rescan  ? help  q quit');
    expect(bar('agents', 120)).toContain('↑↓ select  ←→ range');
    expect(bar('agents', 120)).not.toContain('1-4 tabs');
    expect(bar('insights', 160)).toContain('1-4 tabs  Tab next tab  s rescan  ? help  q quit');
    expect(bar('insights', 120)).not.toContain('range');
  });

  it('uses a short mode pill instead of clipping it at 80 columns', () => {
    const header = (mode: string, width: number) =>
      toPlainText(renderFrame({ ...state(), mode }, { theme: 'dark' }, width, 24, STILL).buffer).split('\n')[0]!;
    expect(header('↑ publishing as @orcun', 80)).toContain('↑ @orcun');
    expect(header('↑ publishing as @orcun', 80)).not.toContain('…');
    expect(header('local only', 80)).toMatch(/idle\s+local\s*$/);
    expect(header('↑ publishing as @orcun', 140)).toContain('↑ publishing as @orcun');
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
  return {
    writes, get restored() { return restored; },
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
});
