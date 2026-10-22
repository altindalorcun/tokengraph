import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeUsage } from '../../src/ledger.js';
import { initialState, reduce, type AppState } from '../../src/tui/app-state.js';
import { buildViewModel, shiftDate } from '../../src/tui/model.js';
import type { InputEvent } from '../../src/tui/input.js';
import { filterEntries, paletteEntries } from '../../src/tui/views/palette.js';

const TODAY = '2026-10-03';
const counts = { inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };

function state(): AppState {
  const ledger = mergeUsage(emptyLedger(), 'claude-code', [{ date: shiftDate(TODAY, -1), model: 'claude-sonnet-4-5', pricingTier: 'standard', counts }]);
  return initialState(buildViewModel(ledger, TODAY), 'local only');
}

const typed = (s: AppState, text: string): AppState =>
  [...text].reduce((acc, char) => reduce(acc, { type: 'char', char }, null).state, s);
const press = (s: AppState, event: InputEvent) => reduce(s, event, null);
const key = (name: Extract<InputEvent, { type: 'key' }>['key']): InputEvent => ({ type: 'key', key: name });
const open = (s = state()): AppState => typed(s, ':');

describe('filterEntries', () => {
  const entries = paletteEntries(state());

  const hooks = ['Claude Code hook', 'Codex notify', 'Cursor hook', 'Gemini CLI hook'];

  it('lists the four hook items first for "hook", Codex notify included', () => {
    const titles = filterEntries(entries, 'hook').map((e) => e.title);
    expect([...titles.slice(0, 4)].sort()).toEqual(hooks);
    expect(titles.slice(0, 3)).toEqual(['Claude Code hook', 'Cursor hook', 'Gemini CLI hook']);
  });

  it('finds the hook entries by their CLI command name', () => {
    expect([...filterEntries(entries, 'install-hook').map((e) => e.title)].sort()).toEqual(hooks);
    expect(filterEntries(entries, 'cron')[0]!.title).toBe('Hourly sync');
  });

  it('matches a subsequence of the title', () => {
    expect(filterEntries(entries, 'cch').map((e) => e.title)).toContain('Claude Code hook');
  });

  it('ranks word prefixes before substrings before subsequences, keeping order inside a rank', () => {
    const list = [
      { title: 'Alpha tools', section: 'S', detail: '', keywords: '', target: { command: 'help' as const } },
      { title: 'Beta tool', section: 'S', detail: '', keywords: '', target: { command: 'help' as const } },
      { title: 'Stool', section: 'S', detail: '', keywords: '', target: { command: 'help' as const } },
      { title: 'Tiny odd lamp', section: 'S', detail: '', keywords: '', target: { command: 'help' as const } },
    ];
    expect(filterEntries(list, 'TOOL').map((e) => e.title)).toEqual(['Alpha tools', 'Beta tool', 'Stool']);
    expect(filterEntries(list, 'tol').map((e) => e.title)).toEqual(['Alpha tools', 'Beta tool', 'Stool', 'Tiny odd lamp']);
  });

  it('returns everything in order for an empty query and nothing when nothing matches', () => {
    expect(filterEntries(entries, '')).toEqual(entries);
    expect(filterEntries(entries, 'zzzqx')).toEqual([]);
  });

  it('offers every action plus the navigation and view commands', () => {
    const titles = entries.map((e) => e.title);
    for (const t of ['Go to Overview', 'Go to Models', 'Go to Agents', 'Go to Insights', 'Go to Setup', 'Rescan now', 'Switch colours', 'Jump to today', 'Show keys']) expect(titles).toContain(t);
    expect(titles).toContain('Uninstall tokengraph');
  });
});

describe('palette in the reducer', () => {
  it('opens with : or Ctrl-K from every tab', () => {
    for (const tab of ['overview', 'models', 'agents', 'insights', 'setup'] as const) {
      expect(open({ ...state(), tab }).palette).toEqual({ query: '', selected: 0 });
      expect(press({ ...state(), tab }, { type: 'ctrl', char: 'k' }).state.palette).toEqual({ query: '', selected: 0 });
    }
  });

  it('types q, digits, s and c into the query without quitting, switching tab or rescanning', () => {
    let s = open();
    for (const char of ['q', '1', '2', 's', 'c', 'h', 't', '?']) {
      const out = press(s, { type: 'char', char });
      expect(out.effects).toEqual([]);
      s = out.state;
    }
    expect(s.palette!.query).toBe('q12sch' + 't?');
    expect(s.tab).toBe('overview');
    expect(s.colorMode).toBe('per-model');
    expect(s.help).toBe(false);
  });

  it('deletes with Backspace, resets the selection on edits and moves within the filtered list', () => {
    let s = typed(open(), 'hook');
    s = press(s, key('down')).state;
    expect(s.palette!.selected).toBe(1);
    s = press(s, key('backspace')).state;
    expect(s.palette).toEqual({ query: 'hoo', selected: 0 });
    s = typed(s, 'k');
    for (let i = 0; i < 50; i += 1) s = press(s, key('down')).state;
    const last = filterEntries(paletteEntries(state()), 'hook').length - 1;
    expect(s.palette!.selected).toBe(last);
    expect(press(press(s, key('up')).state, key('up')).state.palette!.selected).toBe(last - 2);
    expect(press(open(), key('backspace')).state.palette!.query).toBe('');
  });

  it('runs an action entry through requestAction and closes the palette', () => {
    const out = press(typed(open(), 'claude code hook'), key('enter'));
    expect(out.state.palette).toBeNull();
    expect(out.state.confirm).toMatchObject({ id: 'hook:claude-code' });
    const plain = press(typed(open(), 'show status'), key('enter'));
    expect(plain.state.palette).toBeNull();
    expect(plain.effects).toEqual([{ run: 'status' }]);
  });

  it('switches tab on a navigation entry and closes', () => {
    const out = press(typed(open(), 'go to models'), key('enter'));
    expect(out.state.tab).toBe('models');
    expect(out.state.palette).toBeNull();
  });

  it('runs the view commands', () => {
    expect(press(typed(open(), 'rescan'), key('enter')).effects).toEqual(['rescan']);
    expect(press(typed(open(), 'switch col'), key('enter')).state.colorMode).toBe('single');
    expect(press(typed(open(), 'show keys'), key('enter')).state.help).toBe(true);
    const away = { ...state(), tab: 'models' as const, overview: { cursor: shiftDate(TODAY, -9), yearEnd: shiftDate(TODAY, -30) } };
    const today = press(typed(open(away), 'jump to today'), key('enter')).state;
    expect(today.tab).toBe('overview');
    expect(today.overview).toEqual({ cursor: TODAY, yearEnd: TODAY });
  });

  it('closes on Esc and on Ctrl-K without quitting, and does nothing on Enter with no match', () => {
    const typedState = typed(open(), 'abc');
    const esc = press(typedState, key('escape'));
    expect(esc.state.palette).toBeNull();
    expect(esc.effects).toEqual([]);
    expect(press(typedState, { type: 'ctrl', char: 'k' }).state.palette).toBeNull();
    expect(press(typed(open(), 'zzzqx'), key('enter')).state.palette).not.toBeNull();
  });

  it('still quits on Ctrl-C and ignores mouse and other keys while open', () => {
    const s = open();
    expect(press(s, { type: 'ctrl', char: 'c' }).effects).toEqual(['quit']);
    expect(press(s, key('tab')).state).toBe(s);
    expect(press(s, { type: 'mouse', action: 'wheeldown', x: 1, y: 1, button: 65 }).state).toBe(s);
  });
});
