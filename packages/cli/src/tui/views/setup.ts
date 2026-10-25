import { cliCommand, type ActionId, type ActionItem } from '../actions.js';
import { ScreenBuffer, type Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { truncate } from './dates.js';
import { blit, type Hit, type ViewResult } from './props.js';

const MAX_WIDTH = 104;
const MAX_TITLE_W = 30;
const TAG = 'recommended';
const RUNNING = 'running…';
const HEADER_HEIGHT = 2; // progress line, blank line

export interface SetupProps {
  theme: TuiTheme;
  items: readonly ActionItem[];
  progress: { done: number; total: number };
  selected: number;
  running: ActionId | null;
  /** The configuration has not been read yet. */
  loading: boolean;
}

type Line = { kind: 'blank' } | { kind: 'heading'; text: string } | { kind: 'item'; index: number };

/** Section headings and blank lines between the items, which arrive grouped by section. */
function layout(items: readonly ActionItem[]): Line[] {
  const lines: Line[] = [];
  items.forEach((item, index) => {
    if (index === 0 || item.section !== items[index - 1]!.section) {
      if (index > 0) lines.push({ kind: 'blank' });
      lines.push({ kind: 'heading', text: item.section.toUpperCase() });
    }
    lines.push({ kind: 'item', index });
  });
  return lines;
}

function drawHeader(view: ScreenBuffer, width: number, props: SetupProps): void {
  const { theme, progress, loading } = props;
  let x = view.text(0, 0, 'Setup', { fg: theme.ink, bold: true });
  if (loading) {
    view.text(x, 0, ' · reading your configuration…', { fg: theme.muted });
    return;
  }
  const allDone = progress.done >= progress.total;
  if (allDone) {
    x += view.text(x, 0, ' · ', { fg: theme.muted });
    x += view.text(x, 0, 'All set', { fg: theme.good, bold: true });
  } else {
    x += view.text(x, 0, ` · ${progress.done} of ${progress.total} recommended steps done`, { fg: theme.muted });
  }
  // One segment per step.
  const filled = Math.min(progress.done, progress.total);
  x += 2;
  if (x + progress.total > width) return;
  x += view.text(x, 0, '▰'.repeat(filled), { fg: allDone ? theme.good : theme.accent });
  view.text(x, 0, '▱'.repeat(progress.total - filled), { fg: theme.faint });
}

/** The state mark of a toggle: ✓ on, — off, ? unknown; plain actions have none. */
function drawMark(view: ScreenBuffer, x: number, y: number, state: ActionItem['state'], theme: TuiTheme, row: { bg?: string }): void {
  if (state === 'on') view.text(x, y, '✓', { fg: theme.good, bold: true, ...row });
  else if (state === 'off') view.text(x, y, '—', { fg: theme.muted, ...row });
  else if (state === 'unknown') view.text(x, y, '?', { fg: theme.muted, ...row });
}

/**
 * The tab where everything the CLI can do is one keypress away: a progress header, then the actions
 * grouped by section. The list scrolls to keep the selected row on screen; every row is clickable.
 */
export function drawSetup(buf: ScreenBuffer, rect: Rect, props: SetupProps): ViewResult {
  const { theme, items, running } = props;
  const view = new ScreenBuffer(rect.width, rect.height);
  const width = Math.min(view.width, MAX_WIDTH);
  const hits: Hit[] = [];
  drawHeader(view, width, props);

  const lines = layout(items);
  const area = Math.max(0, view.height - HEADER_HEIGHT);
  const selected = Math.max(0, Math.min(props.selected, items.length - 1));
  // Scroll just far enough to show the selected row, keeping its section heading in view when it opens the section.
  const at = lines.findIndex((line) => line.kind === 'item' && line.index === selected);
  const opensSection = at > 0 && lines[at - 1]!.kind === 'heading';
  const offset = Math.max(0, Math.min(at + 1 - area, opensSection ? at - 1 : at));

  const titleW = Math.min(MAX_TITLE_W, Math.floor(width * 0.4));
  const detailX = 4 + titleW + 2;
  const tagW = TAG.length;
  const detailW = Math.max(0, width - detailX - tagW - 2);
  for (let k = 0; k < area; k++) {
    const line = lines[offset + k];
    if (!line) break;
    const y = HEADER_HEIGHT + k;
    if (line.kind === 'heading') {
      const used = view.text(0, y, line.text, { fg: theme.muted, bold: true });
      if (width - used - 1 > 0) view.fill({ x: used + 1, y, width: width - used - 1, height: 1 }, '─', { fg: theme.border });
    } else if (line.kind === 'item') {
      const item = items[line.index]!;
      const isSelected = line.index === selected;
      const row: { bg?: string } = isSelected ? { bg: theme.panel } : {};
      if (isSelected) view.fill({ x: 0, y, width, height: 1 }, ' ', row);
      if (isSelected) view.text(0, y, '▸', { fg: theme.accent, bold: true, ...row });
      drawMark(view, 2, y, item.state, theme, row);
      view.text(4, y, truncate(item.title, titleW), { fg: theme.ink, bold: isSelected, ...row });
      if (detailW > 0) view.text(detailX, y, truncate(item.detail, detailW), { fg: theme.muted, ...row });
      if (running === item.id) view.text(width - RUNNING.length, y, RUNNING, { fg: theme.accent, bold: true, ...row });
      else if (item.recommended) view.text(width - tagW, y, TAG, { fg: theme.accent, ...row });
      hits.push({ kind: 'action', id: item.id, rect: { x: rect.x, y: rect.y + y, width, height: 1 } });
    }
  }
  // Under a list that fits whole, after a blank row: the command line for the selected row.
  const commandY = HEADER_HEIGHT + lines.length + 1;
  if (offset === 0 && commandY < view.height && items[selected]) {
    view.text(0, commandY, truncate(`$ ${cliCommand(items[selected]!)}`, width), { fg: theme.muted });
  }
  // A quiet cue that the list goes on below the last drawn line.
  const lastShown = Math.min(lines.length, offset + area);
  if (lastShown < lines.length && area > 0 && width >= 8) view.text(width - 6, 0, '↓ more', { fg: theme.faint });
  blit(buf, view, rect.x, rect.y);
  return { hits };
}
