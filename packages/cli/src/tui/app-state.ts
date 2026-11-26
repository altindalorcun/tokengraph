import type { LimitsBlock } from './views/limits.js';
import type { ColorMode } from '@tokengraph/core';
import { actionItems, type ActionId, type ActionItem, type SetupStatus } from './actions.js';
import type { AutoSyncStatus } from './auto-sync.js';
import type { FrameHits } from './frame.js';
import type { InputEvent } from './input.js';
import { RANGES, agentBreakdown, hourProfile, modelBreakdown, projectSummaries, shiftDate, type RangeKey, type ViewModel } from './model.js';
import type { OverviewState, TableState } from './views/props.js';
import { clampSelection, filterEntries, paletteEntries } from './views/palette.js';
import { openStoryPanel, storyKey, type StoryCommand, type StoryPanel } from './story-panel.js';
import { openTaskPanel, taskKey, type TaskCommand, type TaskPanel } from './task-panel.js';
import { openProjectPanel, projectPanelKey, type ProjectPanel, type ProjectPanelKind } from './project-panel.js';
import type { ProjectEdit } from '../project-names.js';
import { hitTest } from './widgets/heatmap.js';

export type TabKey = 'overview' | 'models' | 'agents' | 'projects' | 'insights' | 'setup';
export const TABS: readonly TabKey[] = ['overview', 'models', 'agents', 'projects', 'insights', 'setup'];

export interface AppState {
  vm: ViewModel;
  tab: TabKey;
  overview: OverviewState;
  table: TableState;
  /** The selected row of the Setup tab, an index into `actionItems(...)`. */
  setupSel: number;
  /** The hour picked on Insights; null shows the busiest hour. */
  clockHour: number | null;
  colorMode: ColorMode;
  help: boolean;
  /** The command palette while open: what was typed and the highlighted match. */
  palette: { query: string; selected: number } | null;
  mode: string;
  /** Every machine (this one plus the cached others) or this machine alone; `a` switches. */
  scope: Scope;
  /** The other machines cached by the last publish: how many, and when that publish finished (ISO, null if unknown); null until read. */
  machines: { count: number; publishedAt: string | null } | null;
  /** Whether the session rescans on its own (false with --no-live). */
  live: boolean;
  scan: { running: boolean; current: string | null; done: number; total: number; lastScanAt: number | null; note: string | null };
  detected: string[];
  autoSync: AutoSyncStatus | null;
  /** Plan limit readings for the Overview, as of the last load; null until read (or when the app has no source for them). */
  limits: LimitsBlock | null;
  /** Weighted tokens per minute over the last 15 minutes, null until two samples exist. */
  burnRate: number | null;
  /** No usage and the first scan found no agents. */
  empty: boolean;
  /** Config and installed hooks as of the last load; null until read. */
  setup: SetupStatus | null;
  /** The outcome of the last action, shown in the status bar for a few seconds. `at` is on the app clock. */
  toast: { text: string; tone: ToastTone; at: number } | null;
  /** An action waiting for y / n. */
  confirm: { id: ActionId; text: string } | null;
  /** The action being run, or `projects` while a project edit is written and the view reloads its names. */
  running: ActionId | 'projects' | null;
  /** The story cards box while open; it counts as running `story`, so scans wait until it closes. */
  story: StoryPanel | null;
  /** The task box of a running or finished `task` action; `running` stays set until the app has reloaded after it. */
  task: TaskPanel | null;
  /** The merge, rename or split box of the Projects tab while open. */
  projectPanel: ProjectPanel | null;
}

export type Scope = 'all' | 'this';

export const NO_OTHER_MACHINES = 'No other machines yet. Run sync to fetch them.';

/** `info` is a neutral note, such as why a key did nothing. */
export type ToastTone = 'good' | 'bad' | 'info';

export type Effect =
  | 'quit' | 'rescan' | 'bars' | 'wipe'
  /** Rebuild the view model for the new `scope`. */
  | 'scope'
  | { run: ActionId }
  | StoryCommand
  | TaskCommand
  /** Write the edit to the config, then reload the project names; `running` is `projects` until that is done. */
  | ProjectEdit
  /** A toast on the app clock, which the reducer does not have. */
  | { toast: string; tone: ToastTone };
export interface Reduced {
  state: AppState;
  effects: Effect[];
}

const WINDOW_DAYS = 364;

/** The state a fresh session starts in: today selected, 30-day tables, one colour per model family. */
export function initialState(vm: ViewModel, mode: string, live = true, scope: Scope = 'all'): AppState {
  return {
    vm,
    tab: 'overview',
    overview: { cursor: vm.today, yearEnd: vm.today },
    table: { range: '30d', selected: 0 },
    setupSel: 0,
    clockHour: null,
    colorMode: 'per-model',
    help: false,
    palette: null,
    mode,
    scope,
    machines: null,
    live,
    scan: { running: false, current: null, done: 0, total: 0, lastScanAt: null, note: null },
    detected: [],
    autoSync: null,
    limits: null,
    burnRate: null,
    empty: false,
    setup: null,
    toast: null,
    confirm: null,
    running: null,
    story: null,
    task: null,
    projectPanel: null,
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
  if (state.tab === 'projects') return projectSummaries(vm, table.range).length;
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
  return actionItems(state.setup, state.vm.localSources);
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

/** Selects the Projects row of `project` in the current range; a project the range does not show keeps the row in bounds. */
export function selectProject(state: AppState, project: string): AppState {
  const index = projectSummaries(state.vm, state.table.range).findIndex((row) => row.name === project);
  return selectRow(state, index < 0 ? state.table.selected : index);
}

const PROJECT_KEYS: Readonly<Record<string, ProjectPanelKind>> = { m: 'merge', n: 'rename', x: 'split' };

/**
 * Opens the merge, rename or split box for the selected project; only one box at a time, and never while an action
 * or another edit runs. A project the box cannot work on (Not assigned, one folder to split) gets a neutral toast.
 */
function openProjectBox(state: AppState, kind: ProjectPanelKind): Reduced {
  const busy = state.running !== null || state.task || state.story || state.confirm || state.palette || state.projectPanel || state.help;
  if (busy || state.tab !== 'projects') return { state, effects: [] };
  const rows = projectSummaries(state.vm, state.table.range);
  const project = rows[Math.min(Math.max(0, state.table.selected), rows.length - 1)];
  if (!project) return { state, effects: [] };
  const opened = openProjectPanel(kind, state.vm.projectRows, project.name, state.vm.home);
  if (typeof opened === 'string') return { state, effects: [{ toast: opened, tone: 'info' }] };
  return { state: { ...state, projectPanel: opened }, effects: [] };
}

function isTable(tab: TabKey): boolean {
  return tab === 'models' || tab === 'agents' || tab === 'projects';
}

/** Up/down: a day on Overview, a row on Models and Agents, an action on Setup. */
function vertical(state: AppState, step: number): Reduced {
  if (state.tab === 'setup') return { state: selectSetup(state, state.setupSel + step), effects: [] };
  if (state.tab === 'overview') return { state: moveCursor(state, step), effects: [] };
  if (isTable(state.tab)) return { state: selectRow(state, state.table.selected + step), effects: [] };
  return { state, effects: [] };
}

function onChar(state: AppState, char: string): Reduced {
  const none = (next: AppState = state): Reduced => ({ state: next, effects: [] });
  if (char === ':' && !state.help) return none({ ...state, palette: { query: '', selected: 0 } });
  if (char === 'q') return { state, effects: ['quit'] };
  if (char === '?') return none({ ...state, help: !state.help });
  if (state.help) return none();
  if (char >= '1' && char <= String(TABS.length)) return withTab(state, TABS[Number(char) - 1]!);
  if (char === 'h' && state.tab === 'agents') return openSetup(state, 'hook:claude-code');
  if (char === 'u' && state.setup?.update?.latest) return requestAction(state, 'update');
  if (char === 'c') return none(toggleColour(state));
  if (char === 's') return { state, effects: ['rescan'] };
  if (char === 'a') return toggleScope(state);
  if (state.tab === 'overview') {
    const today = state.vm.today;
    if (char === 't') return none({ ...state, overview: { cursor: today, yearEnd: today } });
    if (char === '[') return none(shiftYear(state, shiftDate(state.overview.yearEnd, -WINDOW_DAYS)));
    if (char === ']') {
      const forward = shiftDate(state.overview.yearEnd, WINDOW_DAYS);
      return none(shiftYear(state, forward < today ? forward : today));
    }
  } else if (isTable(state.tab) && char === 'r') {
    return stepRange(state, 1);
  }
  const kind = PROJECT_KEYS[char];
  if (kind && state.tab === 'projects') return openProjectBox(state, kind);
  return none();
}

/** All machines ⇄ this machine; with no other machine cached there is nothing to switch to, and the toast says why. */
function toggleScope(state: AppState): Reduced {
  if (!state.machines || state.machines.count === 0) return { state, effects: [{ toast: NO_OTHER_MACHINES, tone: 'info' }] };
  return { state: { ...state, scope: state.scope === 'all' ? 'this' : 'all' }, effects: ['scope'] };
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
  if ('project' in target) {
    const moved = withTab(closed, 'projects');
    const opened = openProjectBox(moved.state, target.project);
    return { state: opened.state, effects: [...moved.effects, ...opened.effects] };
  }
  switch (target.command) {
    case 'rescan': return { state: closed, effects: ['rescan'] };
    case 'colour': return none(toggleColour(closed));
    case 'scope': return toggleScope(closed);
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
  if (isTable(state.tab)) {
    if (key === 'left') return stepRange(state, -1);
    if (key === 'right') return stepRange(state, 1);
  }
  if (state.tab === 'insights' && (key === 'left' || key === 'right')) return { state: stepHour(state, key === 'left' ? -1 : 1), effects: [] };
  return { state, effects: [] };
}

/** Moves the Insights hour by `step`, wrapping round midnight; starts from the busiest hour; a no-op without hour data. */
function stepHour(state: AppState, step: number): AppState {
  const busiest = hourProfile(state.vm).busiest;
  if (!busiest) return state;
  return { ...state, clockHour: ((state.clockHour ?? busiest.hour) + step + 24) % 24 };
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
    if (event.action === 'press') {
      const action = hits.view.hits.find((h) => h.kind === 'action' && x >= h.rect.x && x < h.rect.x + h.rect.width && y >= h.rect.y && y < h.rect.y + h.rect.height);
      if (action?.kind === 'action') return openSetup(state, action.id);
    }
    const heat = hits.view.heatmap;
    const date = heat ? hitTest(heat.layout, heat.grid, x, y) : null;
    if (date && (event.action === 'move' || event.action === 'press')) return { state: setCursor(state, date), effects: [] };
    return { state, effects: [] };
  }
  if (state.tab === 'insights') {
    if (event.action !== 'move' && event.action !== 'press') return { state, effects: [] };
    const hit = hits.view.hits.find((h) => h.kind === 'hour' && x >= h.rect.x && x < h.rect.x + h.rect.width && y >= h.rect.y && y < h.rect.y + h.rect.height);
    return hit?.kind === 'hour' ? { state: { ...state, clockHour: hit.hour }, effects: [] } : { state, effects: [] };
  }
  if (event.action !== 'press' || (!isTable(state.tab) && state.tab !== 'setup')) return { state, effects: [] };
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
  const item = actionItems(state.setup, state.vm.localSources).find((candidate) => candidate.id === id);
  if (item?.confirm) return { state: { ...state, confirm: { id, text: item.confirm } }, effects: [] };
  return startAction(state, id);
}

/** Runs a confirmed action: story cards and `task` actions open their box at once (the app starts the command), the rest run behind the view. */
function startAction(state: AppState, id: ActionId): Reduced {
  if (state.running !== null) return { state, effects: [] };
  const item = actionItems(state.setup, state.vm.localSources).find((candidate) => candidate.id === id);
  if (item?.kind === 'panel') return { state: { ...state, story: openStoryPanel(), running: id }, effects: [] };
  if (item?.kind === 'task') return { state: { ...state, task: openTaskPanel(id, item.title), running: id }, effects: [{ task: 'start', id }] };
  return { state, effects: [{ run: id }] };
}

/** While a question is open only y / Enter and n / Esc count, and Ctrl-C still quits. */
function onConfirm(state: AppState, event: InputEvent, id: ActionId): Reduced {
  if (event.type === 'ctrl' && event.char === 'c') return { state, effects: ['quit'] };
  const cleared = { ...state, confirm: null };
  if ((event.type === 'char' && event.char === 'y') || (event.type === 'key' && event.key === 'enter')) {
    return startAction(cleared, id);
  }
  if ((event.type === 'char' && event.char === 'n') || (event.type === 'key' && event.key === 'escape')) {
    return { state: cleared, effects: [] };
  }
  return { state, effects: [] };
}

/** While the story box is open it takes every key; closing it ends the run, and the app stops the session. */
function onStory(state: AppState, event: InputEvent, story: StoryPanel): Reduced {
  const { panel, command } = storyKey(story, event);
  if (command?.story === 'close') return { state: { ...state, story: null, running: null }, effects: [command] };
  return { state: { ...state, story: panel }, effects: command ? [command] : [] };
}

/**
 * While the task box is open it takes every key, Ctrl-C included: one Ctrl-C never quits mid-command (only a second
 * one soon after, see `taskKey`). Closing it hides the box; `running` stays until the app has reloaded what the
 * command may have changed.
 */
function onTask(state: AppState, event: InputEvent, task: TaskPanel, hits: FrameHits | null, now: number | null): Reduced {
  const { panel, command } = taskKey(task, event, hits?.task ?? null, now);
  if (command?.task === 'close') return { state: { ...state, task: null }, effects: [command] };
  return { state: { ...state, task: panel }, effects: command ? [command] : [] };
}

/** While a project box is open it takes every key. An edit closes it, and `running` holds the view until it is applied. */
function onProjectPanel(state: AppState, event: InputEvent, current: ProjectPanel): Reduced {
  const { panel, command } = projectPanelKey(current, event);
  if (!command) return { state: { ...state, projectPanel: panel }, effects: [] };
  if (command.projects === 'close') return { state: { ...state, projectPanel: null }, effects: [] };
  return { state: { ...state, projectPanel: null, running: 'projects' }, effects: [command] };
}

/** Pure reducer for input events; returns the next state and side-effect requests. `now` is the app clock (the task box's key timing). */
export function reduce(state: AppState, event: InputEvent, hits: FrameHits | null, now: number | null = null): Reduced {
  if (state.task) return onTask(state, event, state.task, hits, now);
  if (state.story) return onStory(state, event, state.story);
  if (state.projectPanel) return onProjectPanel(state, event, state.projectPanel);
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
