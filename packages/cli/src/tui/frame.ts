import { formatTokens, type Theme } from '@tokengraph/core';
import type { AppState } from './app-state.js';
import { TABS } from './app-state.js';
import { actionItems, setupProgress, type ActionItem } from './actions.js';
import type { Motion } from './animate.js';
import { mix } from './color.js';
import { machinesLine } from './machines.js';
import { ScreenBuffer, type Rect } from './screen.js';
import { tuiTheme, type TuiTheme } from './theme.js';
import { drawAgents } from './views/agents.js';
import { drawConfirm } from './views/confirm.js';
import { drawEmpty } from './views/empty.js';
import { drawHelp } from './views/help.js';
import { drawInsights } from './views/insights.js';
import { drawPalette, filterEntries, paletteEntries } from './views/palette.js';
import { drawModels } from './views/models.js';
import { drawOverview } from './views/overview.js';
import { drawProjectPanel } from './views/project-panel.js';
import { drawProjects } from './views/projects.js';
import { drawSetup } from './views/setup.js';
import { drawStory } from './views/story.js';
import { drawTask } from './views/task.js';
import type { TaskViewport } from './task-panel.js';
import type { ViewProps, ViewResult } from './views/props.js';
import { MIN_HEIGHT, MIN_WIDTH, drawTooSmall } from './views/too-small.js';
import { drawHeaderMark } from './widgets/logo.js';
import { drawTabs, type TabHit } from './widgets/tabs.js';

export interface FrameHits {
  tabs: TabHit[];
  view: ViewResult;
  /** The task box's output rows as drawn, for scrolling it; absent while it is closed. */
  task?: TaskViewport;
}

const TAB_LABELS = ['Overview', 'Models', 'Agents', 'Projects', 'Insights', 'Setup'];
const HINTS: Record<AppState['tab'], string> = {
  overview: '←↑↓→ day  [ ] year  t today  c colour  s rescan  : actions  ? help  q quit',
  models: '↑↓ select  ←→ range  c colour  s rescan  : actions  ? help  q quit',
  agents: '↑↓ select  ←→ range  c colour  h hooks  s rescan  : actions  ? help  q quit',
  projects: '↑↓ select  ←→ range  m merge  n rename  x split  s rescan  : actions  ? help  q quit',
  insights: '←→ hour  s rescan  : actions  ? help  q quit',
  setup: '↑↓ select  enter run  s rescan  : actions  ? help  q quit',
};
const WIDE_HINTS_WIDTH = 140; // wide screens also list the number keys
const LIVE_WINDOW_MS = 60_000;
const NARROW_TABS_WIDTH = 100; // below this the tabs sit one space apart so the mode pill keeps its room
const TABS_X = 18; // the mark and wordmark end at column 15; leave a gap
const NARROW_TABS_X = 6; // below NARROW_TABS_WIDTH the wordmark gives way, so six tabs and the mode pill still fit
const PROGRESS_SEGMENTS = 4;
const MACHINES_LINE_LEFT = 6; // the two-row mark ends before this column
const TOAST_MS = 4000;
const TOAST_MARKS = { good: '✓', bad: '✗', info: '·' } as const;

// Hints that give way first when the status bar is short; help and quit stay as long as anything does.
const HINT_DROP_ORDER = ['s rescan', ': actions', 'c colour', '[ ] year', 't today'];

/** The key hints that fit in `max` columns: whole hints are left out, lowest value first, rather than one cut mid-word. */
export function fitHints(text: string, max: number): string {
  const hints = text.split('  ');
  const width = (list: readonly string[]): number => [...list.join('  ')].length;
  for (const drop of HINT_DROP_ORDER) {
    if (width(hints) <= max) break;
    const at = hints.indexOf(drop);
    if (at >= 0) hints.splice(at, 1);
  }
  // Then the tab's own hints from the right, keeping the first one, help and quit.
  while (width(hints) > max && hints.length > 3) hints.splice(hints.length - 3, 1);
  return width(hints) <= max ? hints.join('  ') : clip(hints.join('  '), max);
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join('') + (max > 0 ? '…' : '');
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  return s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

/** Compact form of the mode text: 'local only' -> 'local', '↑ publishing as @u' -> '↑ @u'. */
function shortMode(mode: string): string {
  if (mode === 'local only') return 'local';
  return mode.replace(/^(↑) publishing as /, '$1 ');
}

/** Row 0, right-hand side: the LIVE indicator and the mode pill, clipped so they never run into the tabs. */
function drawHeaderRight(buf: ScreenBuffer, state: AppState, theme: TuiTheme, motion: Motion, tabsEnd: number): void {
  const { scan } = state;
  const recent = scan.lastScanAt !== null && motion.now - scan.lastScanAt <= LIVE_WINDOW_MS;
  const live = state.live && (scan.running || recent);
  // Full text, then the short form; the pill wins over the idle/LIVE indicator, which is dropped when it no longer fits.
  const withIndicator = Math.max(0, buf.width - 1 - tabsEnd - 2 - 8 - 2);
  const withoutIndicator = Math.max(0, buf.width - 1 - tabsEnd - 2 - 2);
  const forms = [state.mode, shortMode(state.mode)];
  const fits = (room: number) => forms.find((form) => [...form].length <= room);
  const mode = fits(withIndicator) ?? fits(withoutIndicator) ?? forms[1]!;
  const pill = ` ${clip(mode, withoutIndicator)} `;
  const pillX = buf.width - 1 - pill.length;
  buf.text(pillX, 0, pill, { fg: theme.muted, bg: theme.panel });
  const indicatorX = pillX - 2 - 6;
  if (indicatorX <= tabsEnd) return;
  if (live) {
    // Pulse between 40% and 100% of the full green so the dot reads as a heartbeat.
    const level = 0.7 + 0.3 * Math.sin(motion.now / 400);
    buf.text(indicatorX, 0, '● LIVE', { fg: mix(theme.bg, theme.live, level), bold: true });
  } else {
    buf.text(indicatorX, 0, '○ idle', { fg: theme.faint });
  }
}

/** Row 1, right-hand side, under the mode pill: the machines line, in the warn colour once the cache is stale. */
function drawMachinesLine(buf: ScreenBuffer, state: AppState, theme: TuiTheme, now: number): void {
  const line = machinesLine(state.machines, state.scope, now);
  if (!line) return;
  const text = clip(line.text, Math.max(0, buf.width - 2 - MACHINES_LINE_LEFT));
  buf.text(buf.width - 2 - [...text].length, 1, text, { fg: line.stale ? theme.warn : theme.muted });
}

function drawStatusBar(buf: ScreenBuffer, state: AppState, theme: TuiTheme, motion: Motion): void {
  const y = buf.height - 1;
  const { scan } = state;
  const parts: { text: string; fg: string }[] = [];
  const latest = state.setup?.update?.latest;
  if (latest) parts.push({ text: `${latest} is out · u to update`, fg: theme.accent });
  if (scan.note) parts.push({ text: clip(scan.note, Math.max(10, Math.floor(buf.width / 2))), fg: theme.bad });
  if (state.burnRate !== null) parts.push({ text: `▲ ${formatTokens(state.burnRate)}/min`, fg: theme.muted });
  const toast = state.toast && motion.now - state.toast.at < TOAST_MS ? state.toast : null;
  if (toast) {
    const text = `${TOAST_MARKS[toast.tone]} ${toast.text}`;
    const fg = toast.tone === 'good' ? theme.good : toast.tone === 'bad' ? theme.bad : theme.muted;
    parts.push({ text: clip(text, Math.max(10, Math.floor(buf.width / 2))), fg });
  } else if (scan.running) {
    const filled = scan.total > 0 ? Math.round((Math.min(scan.done, scan.total) / scan.total) * PROGRESS_SEGMENTS) : 0;
    const bar = '▰'.repeat(filled) + '▱'.repeat(PROGRESS_SEGMENTS - filled);
    parts.push({ text: `scanning ${scan.current ? `${scan.current}… ` : '… '}${bar}`, fg: theme.accent });
  } else if (scan.lastScanAt !== null) {
    parts.push({ text: `scanned ${ago(motion.now - scan.lastScanAt)}`, fg: theme.muted });
  }
  const gap = 2;
  const rightWidth = parts.reduce((sum, p) => sum + [...p.text].length, 0) + gap * Math.max(0, parts.length - 1);
  // The boxes list their own keys; the view's keys do nothing while one is open.
  const hints = state.story || state.task || state.projectPanel ? '' : `${buf.width >= WIDE_HINTS_WIDTH ? `1-${TABS.length} tabs  ` : ''}${HINTS[state.tab]}`;
  const room = Math.max(0, buf.width - 2 - (rightWidth > 0 ? rightWidth + gap : 0));
  buf.text(1, y, fitHints(hints, room), { fg: theme.muted }, room);
  let x = buf.width - 1 - rightWidth;
  for (const part of parts) {
    x += buf.text(x, y, part.text, { fg: part.fg }) + gap;
  }
}

function drawView(buf: ScreenBuffer, rect: Rect, state: AppState, theme: TuiTheme, motion: Motion, items: readonly ActionItem[]): ViewResult {
  // Setup stays usable with no usage yet: that is when hooks matter most.
  if (state.empty && state.tab !== 'setup') {
    drawEmpty(buf, rect, { theme, scanning: state.scan.running });
    return { hits: [] };
  }
  const props: ViewProps = { vm: state.vm, theme, motion, colorMode: state.colorMode };
  switch (state.tab) {
    case 'overview':
      return drawOverview(buf, rect, { ...props, state: state.overview, limits: state.limits });
    case 'models':
      return drawModels(buf, rect, { ...props, state: state.table });
    case 'agents':
      return drawAgents(buf, rect, { ...props, state: state.table, autoSync: state.autoSync, detected: state.detected });
    case 'projects':
      return drawProjects(buf, rect, { ...props, state: state.table });
    case 'insights':
      return drawInsights(buf, rect, { ...props, hour: state.clockHour });
    case 'setup':
      return drawSetup(buf, rect, {
        theme,
        items,
        progress: setupProgress(items, state.setup, state.vm.localSources),
        selected: state.setupSel,
        running: state.running === 'projects' ? null : state.running,
        loading: state.setup === null,
      });
  }
}

/** The whole screen for one state — exported for tests and print. */
export function renderFrame(
  state: AppState,
  /** `now` is the wall clock (ms), for the age of the other machines' figures. */
  deps: { theme: Theme; now?: number },
  width: number,
  height: number,
  motion: Motion,
): { buffer: ScreenBuffer; hits: FrameHits } {
  const theme = tuiTheme(deps.theme);
  const buf = new ScreenBuffer(width, height, { fg: theme.ink, bg: theme.bg });
  if (buf.width < MIN_WIDTH || buf.height < MIN_HEIGHT) {
    drawTooSmall(buf, { x: 0, y: 0, width: buf.width, height: buf.height }, theme);
    return { buffer: buf, hits: { tabs: [], view: { hits: [] } } };
  }
  const narrow = buf.width < NARROW_TABS_WIDTH;
  drawHeaderMark(buf, 1, 0, theme, !narrow);
  const items = actionItems(state.setup, state.vm.localSources);
  const progress = setupProgress(items, state.setup, state.vm.localSources);
  // The Setup tab carries a dot while a recommended step is open (not before the configuration has been read).
  const badged = state.setup !== null && progress.done < progress.total ? [TABS.indexOf('setup')] : [];
  const tabs = drawTabs(buf, narrow ? NARROW_TABS_X : TABS_X, 0, TAB_LABELS, TABS.indexOf(state.tab), theme, badged, narrow ? 1 : 2);
  const last = tabs[tabs.length - 1]!;
  drawHeaderRight(buf, state, theme, motion, last.x + last.width);
  drawMachinesLine(buf, state, theme, deps.now ?? Date.now());
  buf.fill({ x: 1, y: 2, width: buf.width - 2, height: 1 }, '─', { fg: theme.border });

  const rect = { x: 1, y: 3, width: buf.width - 2, height: buf.height - 4 };
  const view = drawView(buf, rect, state, theme, motion, items);
  if (state.help) drawHelp(buf, rect, theme);
  if (state.palette) drawPalette(buf, rect, state.palette, filterEntries(paletteEntries(state), state.palette.query), theme);
  if (state.confirm) drawConfirm(buf, rect, state.confirm.text, theme);
  if (motion.wipe < 1) {
    const edge = rect.x + Math.floor(Math.max(0, motion.wipe) * rect.width);
    buf.fill({ x: edge, y: rect.y, width: rect.x + rect.width - edge, height: rect.height }, ' ', { fg: theme.ink, bg: theme.bg });
  }
  drawStatusBar(buf, state, theme, motion);
  if (state.projectPanel) drawProjectPanel(buf, { x: 0, y: 0, width: buf.width, height: buf.height }, state.projectPanel, theme);
  // Over the whole screen rather than the view, so the QR code has every row the window offers.
  if (state.story) drawStory(buf, { x: 0, y: 0, width: buf.width, height: buf.height }, state.story, theme);
  // Over the whole screen too: status output and the README snippet need the width.
  const task = state.task ? drawTask(buf, { x: 0, y: 0, width: buf.width, height: buf.height }, state.task, theme, motion.now) : undefined;
  return { buffer: buf, hits: task ? { tabs, view, task } : { tabs, view } };
}
