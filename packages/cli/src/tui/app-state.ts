import type { ColorMode } from '@tokengraph/core';
import { actionItems, type ActionId, type ActionItem, type SetupStatus } from './actions.js';
import type { AutoSyncStatus } from './auto-sync.js';
import type { FrameHits } from './frame.js';
import type { InputEvent } from './input.js';
import { RANGES, agentBreakdown, modelBreakdown, shiftDate, type RangeKey, type ViewModel } from './model.js';
import type { OverviewState, TableState } from './views/props.js';
import { clampSelection, filterEntries, paletteEntries } from './views/palette.js';
import { hitTest } from './widgets/heatmap.js';

export type TabKey = 'overview' | 'models' | 'agents' | 'insights' | 'setup';
export const TABS: readonly TabKey[] = ['overview', 'models', 'agents', 'insights', 'setup'];

export interface AppState {
  vm: ViewModel;
  tab: TabKey;
  overview: OverviewState;
  table: TableState;
  /** The selected row of the Setup tab, an index into `actionItems(...)`. */
  setupSel: number;
  colorMode: ColorMode;
  help: boolean;
  /** The command palette while open: what was typed and the highlighted match. */
  palette: { query: string; selected: number } | null;
  mode: string;
  /** Whether the session rescans on its own (false with --no-live). */
  live: boolean;
  scan: { running: boolean; current: string | null; done: number; total: number; lastScanAt: number | null; note: string | null };
  detected: string[];
  autoSync: AutoSyncStatus | null;
  /** Weighted tokens per minute over the last 15 minutes, null until two samples exist. */
  burnRate: number | null;
  /** No usage and the first scan found no agents. */
  empty: boolean;
  /** Config and installed hooks as of the last load; null until read. */
  setup: SetupStatus | null;
  /** The outcome of the last action, shown in the status bar for a few seconds. `at` is on the app clock. */
  toast: { text: string; tone: 'good' | 'bad'; at: number } | null;
  /** An action waiting for y / n. */
  confirm: { id: ActionId; text: string } | null;
  /** The action being run. */
  running: ActionId | null;
}

export type Effect = 'quit' | 'rescan' | 'bars' | 'wipe' | { run: ActionId };
export interface Reduced {
  state: AppState;
  effects: Effect[];
}

const WINDOW_DAYS = 364;

/** The state a fresh session starts in: today selected, 30-day tables, one colour per model family. */
export function initialState(vm: ViewModel, mode: string, live = true): AppState {
  return {
    vm,
    tab: 'overview',
    overview: { cursor: vm.today, yearEnd: vm.today },
    table: { range: '30d', selected: 0 },
    setupSel: 0,
    colorMode: 'per-model',
    help: false,
    palette: null,
    mode,
    live,
    scan: { running: false, current: null, done: 0, total: 0, lastScanAt: null, note: null },
    detected: [],
    autoSync: null,
    burnRate: null,
    empty: false,
    setup: null,
    toast: null,
    confirm: null,
    running: null,
  };
}

/** Swaps in a rebuilt view model; a year view or cursor that sat on the old today follows it past midnight. */
export function withViewModel(state: AppState, vm: ViewModel): AppState {
  const old = state.vm.today;
  if (vm.today === old) return { ...state, vm };
  const { cursor, yearEnd } = state.overview;
  return {
    ...state,
    vm,
    overview: { cursor: cursor === old ? vm.today : cursor, yearEnd: yearEnd === old ? vm.today : yearEnd },
  };
}

function bounds(state: AppState, yearEnd = state.overview.yearEnd): { lo: string; hi: string } {
  const hi = yearEnd < state.vm.today ? yearEnd : state.vm.today;
  return { lo: shiftDate(yearEnd, 1 - WINDOW_DAYS), hi };
}

function clampDate(date: string, lo: string, hi: string): string {
  return date < lo ? lo : date > hi ? hi : date;
}

function moveCursor(state: AppState, days: number): AppState {
  const { lo, hi } = bounds(state);
  const cursor = clampDate(shiftDate(state.overview.cursor, days), lo, hi);
  return { ...state, overview: { ...state.overview, cursor } };
}

function setCursor(state: AppState, date: string): AppState {
  const { lo, hi } = bounds(state);
  if (date < lo || date > hi) return state;
  return { ...state, overview: { ...state.overview, cursor: date } };
}

function shiftYear(state: AppState, yearEnd: string): AppState {
  if (yearEnd === state.overview.yearEnd) return state;
  const delta = (Date.parse(yearEnd) - Date.parse(state.overview.yearEnd)) / 86_400_000;
  const { lo, hi } = bounds(state, yearEnd);
  const cursor = clampDate(shiftDate(state.overview.cursor, delta), lo, hi);
  return { ...state, overview: { cursor, yearEnd } };
}

function rowCount(state: AppState): number {
  const { vm, table } = state;
  if (state.tab === 'models') return modelBreakdown(vm, table.range).length;
  if (state.tab === 'agents') return agentBreakdown(vm, table.range).length;
  return 0;
}

function selectRow(state: AppState, index: number): AppState {
  const selected = Math.max(0, Math.min(index, rowCount(state) - 1));
  return { ...state, table: { ...state.table, selected } };
}

function withTab(state: AppState, tab: TabKey): Reduced {
  if (tab === state.tab) return { state, effects: [] };
  return { state: { ...state, tab, table: { ...state.table, selected: 0 } }, effects: ['bars', 'wipe'] };
}

function cycleTab(state: AppState, step: number): Reduced {
  return withTab(state, TABS[(TABS.indexOf(state.tab) + step + TABS.length) % TABS.length]!);
}

function stepRange(state: AppState, step: number): Reduced {
  return setRange(state, RANGES[(RANGES.indexOf(state.table.range) + step + RANGES.length) % RANGES.length]!);
}

function setRange(state: AppState, range: RangeKey): Reduced {
  const next = { ...state, table: { range, selected: 0 } };
  return { state: next, effects: range === state.table.range ? [] : ['bars'] };
}

function setupItems(state: AppState): ActionItem[] {
  return actionItems(state.setup, state.vm.sources);
}

function selectSetup(state: AppState, index: number): AppState {
  return { ...state, setupSel: Math.max(0, Math.min(index, setupItems(state).length - 1)) };
}

/** Switches to the Setup tab with the row of `id` selected. */
function openSetup(state: AppState, id: ActionId): Reduced {
  const moved = withTab(state, 'setup');
  const index = setupItems(state).findIndex((item) => item.id === id);
  return { state: index < 0 ? moved.state : selectSetup(moved.state, index), effects: moved.effects };
}

/** Up/down: a day on Overview, a row on Models and Agents, an action on Setup. */
function vertical(state: AppState, step: number): Reduced {
  if (state.tab === 'setup') return { state: selectSetup(state, state.setupSel + step), effects: [] };
  if (state.tab === 'overview') return { state: moveCursor(state, step), effects: [] };
  if (state.tab === 'models' || state.tab === 'agents') return { state: selectRow(state, state.table.selected + step), effects: [] };
  return { state, effects: [] };
}

function onChar(state: AppState, char: string): Reduced {
  const none = (next: AppState = state): Reduced => ({ state: next, effects: [] });
  if (char === ':' && !state.help) return none({ ...state, palette: { query: '', selected: 0 } });
  if (char === 'q') return { state, effects: ['quit'] };
  if (char === '?') return none({ ...state, help: !state.help });
  if (state.help) return none();
  if (char >= '1' && char <= '5') return withTab(state, TABS[Number(char) - 1]!);
  if (char === 'h' && state.tab === 'agents') return openSetup(state, 'hook:claude-code');
  if (char === 'c') return none(toggleColour(state));
  if (char === 's') return { state, effects: ['rescan'] };
  if (state.tab === 'overview') {
    const today = state.vm.today;
    if (char === 't') return none({ ...state, overview: { cursor: today, yearEnd: today } });
    if (char === '[') return none(shiftYear(state, shiftDate(state.overview.yearEnd, -WINDOW_DAYS)));
    if (char === ']') {
      const forward = shiftDate(state.overview.yearEnd, WINDOW_DAYS);
      return none(shiftYear(state, forward < today ? forward : today));
    }
  } else if ((state.tab === 'models' || state.tab === 'agents') && char === 'r') {
    return stepRange(state, 1);
  }
  return none();
}

function toggleColour(state: AppState): AppState {
  return { ...state, colorMode: state.colorMode === 'single' ? 'per-model' : 'single' };
}

function jumpToToday(state: AppState): Reduced {
  const today = state.vm.today;
  const moved = withTab(state, 'overview');
  return { state: { ...moved.state, overview: { cursor: today, yearEnd: today } }, effects: moved.effects };
}

/** While the palette is open every key edits the query or moves in the list; only Ctrl-C and Ctrl-K act on the app. */
function onPalette(state: AppState, event: InputEvent, palette: NonNullable<AppState['palette']>): Reduced {
  const none = (next: AppState = state): Reduced => ({ state: next, effects: [] });
  const closed: AppState = { ...state, palette: null };
  if (event.type === 'ctrl') {
    if (event.char === 'c') return { state, effects: ['quit'] };
    return event.char === 'k' ? none(closed) : none();
  }
  const matches = filterEntries(paletteEntries(state), palette.query);
  const select = (selected: number): Reduced =>
    none({ ...state, palette: { ...palette, selected: clampSelection(selected, matches.length) } });
  const edit = (query: string): Reduced => none({ ...state, palette: { query, selected: 0 } });
  if (event.type === 'char') return edit(palette.query + event.char);
  if (event.type !== 'key') return none();
  if (event.key === 'escape') return none(closed);
  if (event.key === 'backspace') return edit([...palette.query].slice(0, -1).join(''));
  const current = clampSelection(palette.selected, matches.length);
  if (event.key === 'up') return select(current - 1);
  if (event.key === 'down') return select(current + 1);
  if (event.key !== 'enter') return none();
  const target = matches[current]?.target;
  if (!target) return none();
  if ('action' in target) return requestAction(closed, target.action);
  if ('tab' in target) return withTab(closed, target.tab);
  switch (target.command) {
    case 'rescan': return { state: closed, effects: ['rescan'] };
    case 'colour': return none(toggleColour(closed));
    case 'today': return jumpToToday(closed);
    case 'help': return none({ ...closed, help: true });
  }
}

function onKey(state: AppState, key: string): Reduced {
  if (key === 'escape') return state.help ? { state: { ...state, help: false }, effects: [] } : { state, effects: ['quit'] };
  if (state.help) return { state, effects: [] };
  if (key === 'tab') return cycleTab(state, 1);
  if (key === 'backtab') return cycleTab(state, -1);
  if (key === 'up') return vertical(state, -1);
  if (key === 'down') return vertical(state, 1);
  if (key === 'enter' && state.tab === 'setup') {
    const item = setupItems(state)[state.setupSel];
    return item ? requestAction(state, item.id) : { state, effects: [] };
  }
  if (state.tab === 'overview') {
    const { lo, hi } = bounds(state);
    if (key === 'left') return { state: moveCursor(state, -7), effects: [] };
    if (key === 'right') return { state: moveCursor(state, 7), effects: [] };
    if (key === 'home') return { state: { ...state, overview: { ...state.overview, cursor: lo } }, effects: [] };
    if (key === 'end') return { state: { ...state, overview: { ...state.overview, cursor: hi } }, effects: [] };
  }
  if (state.tab === 'models' || state.tab === 'agents') {
    if (key === 'left') return stepRange(state, -1);
    if (key === 'right') return stepRange(state, 1);
  }
  return { state, effects: [] };
}

function onMouse(state: AppState, event: Extract<InputEvent, { type: 'mouse' }>, hits: FrameHits | null): Reduced {
  if (state.help || state.palette) return { state, effects: [] };
  if (event.action === 'wheelup') return vertical(state, -1);
  if (event.action === 'wheeldown') return vertical(state, 1);
  if (!hits) return { state, effects: [] };
  const { x, y } = event;
  if (event.action === 'press') {
    const tab = hits.tabs.find((hit) => y === 0 && x >= hit.x && x < hit.x + hit.width);
    if (tab) return withTab(state, TABS[tab.index]!);
  }
  if (state.tab === 'overview') {
    const heat = hits.view.heatmap;
    const date = heat ? hitTest(heat.layout, heat.grid, x, y) : null;
    if (date && (event.action === 'move' || event.action === 'press')) return { state: setCursor(state, date), effects: [] };
    return { state, effects: [] };
  }
  if (event.action !== 'press' || (state.tab !== 'models' && state.tab !== 'agents' && state.tab !== 'setup')) return { state, effects: [] };
  const inside = (r: { x: number; y: number; width: number; height: number }): boolean =>
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
  for (const hit of hits.view.hits) {
    if (hit.kind === 'range' && inside(hit.rect)) return setRange(state, hit.range);
    if (hit.kind === 'row' && inside(hit.rect)) return { state: selectRow(state, hit.index), effects: [] };
    if (hit.kind === 'action' && inside(hit.rect)) {
      // On Agents a status opens its Setup row; on Setup a first press selects the row and a press on the selected one runs it.
      if (state.tab === 'agents') return openSetup(state, hit.id);
      const index = setupItems(state).findIndex((item) => item.id === hit.id);
      return index === state.setupSel ? requestAction(state, hit.id) : { state: selectSetup(state, index), effects: [] };
    }
  }
  return { state, effects: [] };
}

/** Asks for an action: it waits for a y when the action has a confirmation, else runs at once. Ignored while another runs. */
export function requestAction(state: AppState, id: ActionId): Reduced {
  if (state.running !== null) return { state, effects: [] };
  const item = actionItems(state.setup, state.vm.sources).find((candidate) => candidate.id === id);
  if (item?.confirm) return { state: { ...state, confirm: { id, text: item.confirm } }, effects: [] };
  return { state, effects: [{ run: id }] };
}

/** While a question is open only y / Enter and n / Esc count, and Ctrl-C still quits. */
function onConfirm(state: AppState, event: InputEvent, id: ActionId): Reduced {
  if (event.type === 'ctrl' && event.char === 'c') return { state, effects: ['quit'] };
  const cleared = { ...state, confirm: null };
  if ((event.type === 'char' && event.char === 'y') || (event.type === 'key' && event.key === 'enter')) {
    return { state: cleared, effects: [{ run: id }] };
  }
  if ((event.type === 'char' && event.char === 'n') || (event.type === 'key' && event.key === 'escape')) {
    return { state: cleared, effects: [] };
  }
  return { state, effects: [] };
}

/** Pure reducer for input events; returns the next state and side-effect requests. */
export function reduce(state: AppState, event: InputEvent, hits: FrameHits | null): Reduced {
  if (state.confirm) return onConfirm(state, event, state.confirm.id);
  if (state.palette) return onPalette(state, event, state.palette);
  switch (event.type) {
    case 'char':
      return onChar(state, event.char);
    case 'ctrl':
      if (event.char === 'c') return { state, effects: ['quit'] };
      return event.char === 'k' && !state.help ? { state: { ...state, palette: { query: '', selected: 0 } }, effects: [] } : { state, effects: [] };
    case 'key':
      return onKey(state, event.key);
    case 'mouse':
      return onMouse(state, event, hits);
  }
}
