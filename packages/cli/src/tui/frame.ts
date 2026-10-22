import { formatTokens, type Theme } from '@tokengraph/core';
import type { AppState } from './app-state.js';
import { TABS } from './app-state.js';
import { actionItems, setupProgress, type ActionItem } from './actions.js';
import type { Motion } from './animate.js';
import { mix } from './color.js';
import { ScreenBuffer, type Rect } from './screen.js';
import { tuiTheme, type TuiTheme } from './theme.js';
import { drawAgents } from './views/agents.js';
import { drawConfirm } from './views/confirm.js';
import { drawEmpty } from './views/empty.js';
import { drawHelp } from './views/help.js';
import { drawInsights } from './views/insights.js';
import { drawModels } from './views/models.js';
import { drawOverview } from './views/overview.js';
import { drawSetup } from './views/setup.js';
import type { ViewProps, ViewResult } from './views/props.js';
import { MIN_HEIGHT, MIN_WIDTH, drawTooSmall } from './views/too-small.js';
import { drawHeaderMark } from './widgets/logo.js';
import { drawTabs, type TabHit } from './widgets/tabs.js';

export interface FrameHits {
  tabs: TabHit[];
  view: ViewResult;
}

const TAB_LABELS = ['Overview', 'Models', 'Agents', 'Insights', 'Setup'];
const HINTS: Record<AppState['tab'], string> = {
  overview: '←↑↓→ day  [ ] year  t today  c colour  s rescan  ? help  q quit',
  models: '↑↓ select  ←→ range  c colour  s rescan  ? help  q quit',
  agents: '↑↓ select  ←→ range  c colour  h hooks  s rescan  ? help  q quit',
  insights: 'Tab next tab  s rescan  ? help  q quit',
  setup: '↑↓ select  enter run  s rescan  ? help  q quit',
};
const WIDE_HINTS_WIDTH = 140; // wide screens also list the number keys
const LIVE_WINDOW_MS = 60_000;
const NARROW_TABS_WIDTH = 100; // below this the tabs sit one space apart so the mode pill keeps its room
const TABS_X = 18; // the mark and wordmark end at column 15; leave a gap
const PROGRESS_SEGMENTS = 4;
const TOAST_MS = 4000;

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

function drawStatusBar(buf: ScreenBuffer, state: AppState, theme: TuiTheme, motion: Motion): void {
  const y = buf.height - 1;
  const { scan } = state;
  const parts: { text: string; fg: string }[] = [];
  if (scan.note) parts.push({ text: clip(scan.note, Math.max(10, Math.floor(buf.width / 2))), fg: theme.bad });
  if (state.burnRate !== null) parts.push({ text: `▲ ${formatTokens(state.burnRate)}/min`, fg: theme.muted });
  const toast = state.toast && motion.now - state.toast.at < TOAST_MS ? state.toast : null;
  if (toast) {
    const text = `${toast.tone === 'good' ? '✓' : '✗'} ${toast.text}`;
    parts.push({ text: clip(text, Math.max(10, Math.floor(buf.width / 2))), fg: toast.tone === 'good' ? theme.good : theme.bad });
  } else if (scan.running) {
    const filled = scan.total > 0 ? Math.round((Math.min(scan.done, scan.total) / scan.total) * PROGRESS_SEGMENTS) : 0;
    const bar = '▰'.repeat(filled) + '▱'.repeat(PROGRESS_SEGMENTS - filled);
    parts.push({ text: `scanning ${scan.current ? `${scan.current}… ` : '… '}${bar}`, fg: theme.accent });
  } else if (scan.lastScanAt !== null) {
    parts.push({ text: `scanned ${ago(motion.now - scan.lastScanAt)}`, fg: theme.muted });
  }
  const gap = 2;
  const rightWidth = parts.reduce((sum, p) => sum + [...p.text].length, 0) + gap * Math.max(0, parts.length - 1);
  buf.text(1, y, `${buf.width >= WIDE_HINTS_WIDTH ? '1-5 tabs  ' : ''}${HINTS[state.tab]}`, { fg: theme.muted }, Math.max(0, buf.width - 2 - (rightWidth > 0 ? rightWidth + gap : 0)));
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
      return drawOverview(buf, rect, { ...props, state: state.overview });
    case 'models':
      return drawModels(buf, rect, { ...props, state: state.table });
    case 'agents':
      return drawAgents(buf, rect, { ...props, state: state.table, autoSync: state.autoSync, detected: state.detected });
    case 'insights':
      return drawInsights(buf, rect, props);
    case 'setup':
      return drawSetup(buf, rect, {
        theme,
        items,
        progress: setupProgress(items, state.setup, state.vm.sources),
        selected: state.setupSel,
        running: state.running,
        loading: state.setup === null,
      });
  }
}

/** The whole screen for one state — exported for tests and print. */
export function renderFrame(
  state: AppState,
  deps: { theme: Theme },
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
  drawHeaderMark(buf, 1, 0, theme);
  const items = actionItems(state.setup, state.vm.sources);
  const progress = setupProgress(items, state.setup, state.vm.sources);
  // The Setup tab carries a dot while a recommended step is open (not before the configuration has been read).
  const badged = state.setup !== null && progress.done < progress.total ? [TABS.indexOf('setup')] : [];
  const tabs = drawTabs(buf, TABS_X, 0, TAB_LABELS, TABS.indexOf(state.tab), theme, badged, buf.width < NARROW_TABS_WIDTH ? 1 : 2);
  const last = tabs[tabs.length - 1]!;
  drawHeaderRight(buf, state, theme, motion, last.x + last.width);
  buf.fill({ x: 1, y: 2, width: buf.width - 2, height: 1 }, '─', { fg: theme.border });

  const rect = { x: 1, y: 3, width: buf.width - 2, height: buf.height - 4 };
  const view = drawView(buf, rect, state, theme, motion, items);
  if (state.help) drawHelp(buf, rect, theme);
  if (state.confirm) drawConfirm(buf, rect, state.confirm.text, theme);
  if (motion.wipe < 1) {
    const edge = rect.x + Math.floor(Math.max(0, motion.wipe) * rect.width);
    buf.fill({ x: edge, y: rect.y, width: rect.x + rect.width - edge, height: rect.height }, ' ', { fg: theme.ink, bg: theme.bg });
  }
  drawStatusBar(buf, state, theme, motion);
  return { buffer: buf, hits: { tabs, view } };
}
