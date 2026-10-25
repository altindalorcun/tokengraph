import { actionItems, cliCommand, type ActionId, type ActionItem } from '../actions.js';
import type { AppState, TabKey } from '../app-state.js';
import { ScreenBuffer, type Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { truncate } from './dates.js';
import { blit } from './props.js';

export type PaletteTarget = { action: ActionId } | { tab: TabKey } | { command: 'rescan' | 'colour' | 'today' | 'help' };
export interface PaletteEntry {
  title: string;
  section: string;
  detail: string;
  /** Extra words the filter matches but the list never shows. */
  keywords: string;
  target: PaletteTarget;
}

const BOX_WIDTH = 72;
const MAX_ROWS = 10;
const PADDING = 1; // columns between the border and the text

const TAB_ENTRIES: readonly (readonly [TabKey, string, string])[] = [
  ['overview', 'Overview', 'heatmap graph days'],
  ['models', 'Models', 'cost price'],
  ['agents', 'Agents', 'sources hooks status'],
  ['insights', 'Insights', 'stats streak'],
  ['setup', 'Setup', 'settings config'],
];

/** The CLI command name (`install-hook`, `export`, ...) plus words people reach for. */
function actionKeywords(item: ActionItem): string {
  const command = cliCommand(item).split(' ')[1] ?? '';
  const extra = item.id.startsWith('hook:') ? 'hook' : item.id === 'schedule' ? 'schedule cron background' : '';
  return `${command} ${extra}`.trim();
}

/** Every action of the Setup tab, then the navigation and view commands, in the order the palette lists them. */
export function paletteEntries(state: AppState): PaletteEntry[] {
  const actions = actionItems(state.setup, state.vm.sources).map(
    (item): PaletteEntry => ({ title: item.title, section: item.section, detail: item.detail, keywords: actionKeywords(item), target: { action: item.id } }),
  );
  const tabs = TAB_ENTRIES.map(
    ([tab, label, keywords], i): PaletteEntry => ({ title: `Go to ${label}`, section: 'Navigate', detail: `key ${i + 1}`, keywords, target: { tab } }),
  );
  const commands: PaletteEntry[] = [
    { title: 'Rescan now', section: 'View', detail: 'key s', keywords: 'scan refresh reload', target: { command: 'rescan' } },
    { title: 'Switch colours', section: 'View', detail: 'key c', keywords: 'color theme single family', target: { command: 'colour' } },
    { title: 'Jump to today', section: 'View', detail: 'key t', keywords: 'date cursor now', target: { command: 'today' } },
    { title: 'Show keys', section: 'View', detail: 'key ?', keywords: 'help shortcuts keybindings', target: { command: 'help' } },
  ];
  return [...actions, ...tabs, ...commands];
}

function isSubsequence(query: string, text: string): boolean {
  let at = 0;
  for (const ch of text) if (ch === query[at] && ++at === query.length) return true;
  return query.length === 0;
}

/** 0 = a word of the title starts with the query, 1 = the query is a substring, 2 = its characters appear in order, null = no match. */
function rank(entry: PaletteEntry, query: string): number | null {
  const title = entry.title.toLowerCase();
  const haystack = `${title} ${entry.section.toLowerCase()} ${entry.keywords.toLowerCase()}`;
  if (!isSubsequence(query, haystack)) return null;
  if (title.split(' ').some((word) => word.startsWith(query))) return 0;
  return haystack.includes(query) ? 1 : 2;
}

/** The entries that match `query` (case-insensitive), best match first; ties keep the original order. */
export function filterEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.toLowerCase();
  if (needle === '') return [...entries];
  const ranked: { entry: PaletteEntry; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const r = rank(entry, needle);
    if (r !== null) ranked.push({ entry, rank: r, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.entry);
}

/** The title columns the query lights up: the substring when there is one, else the greedy in-order match. */
function matchColumns(title: string, query: string): Set<number> {
  const lower = [...title.toLowerCase()];
  const needle = [...query.toLowerCase()];
  const columns = new Set<number>();
  if (needle.length === 0) return columns;
  const text = lower.join('');
  const start = text.indexOf(needle.join(''));
  if (start >= 0) {
    const from = [...text.slice(0, start)].length;
    needle.forEach((_, i) => columns.add(from + i));
    return columns;
  }
  let at = 0;
  lower.forEach((ch, i) => {
    if (at < needle.length && ch === needle[at]) {
      columns.add(i);
      at += 1;
    }
  });
  return at === needle.length ? columns : new Set();
}

/** Keeps a selection inside a list that may have shrunk since it was made. */
export function clampSelection(selected: number, length: number): number {
  return Math.max(0, Math.min(selected, length - 1));
}

/** Index of the first visible row so the selected one stays inside a window of `rows`. */
function firstRow(selected: number, rows: number): number {
  return Math.max(0, selected - rows + 1);
}

/** A box near the top of the view: the query line, then the matching entries with the selected one on the panel colour. */
export function drawPalette(
  buf: ScreenBuffer,
  rect: Rect,
  palette: { query: string; selected: number },
  entries: readonly PaletteEntry[],
  theme: TuiTheme,
): void {
  const view = new ScreenBuffer(rect.width, rect.height);
  const width = Math.min(view.width, BOX_WIDTH, Math.max(0, rect.width - 4));
  const rows = Math.max(1, Math.min(MAX_ROWS, entries.length, view.height - 5));
  // Box rows: border, query, blank, entries, border.
  const height = Math.min(view.height, rows + 4);
  const box = { x: Math.floor((view.width - width) / 2), y: Math.min(1, Math.max(0, view.height - height)), width, height };
  view.fill(box, ' ', { bg: theme.bg });
  const inner = drawBox(view, box, theme, 'Actions');
  const x = inner.x + PADDING;
  const room = Math.max(1, inner.width - PADDING * 2);
  const prompt = `› ${palette.query}`;
  const shown = truncate(prompt, room - 1);
  view.text(inner.x + PADDING, inner.y, shown, { fg: theme.ink, bg: theme.bg }, room);
  view.text(inner.x + PADDING + [...shown].length, inner.y, '▏', { fg: theme.accent, bg: theme.bg });
  if (entries.length === 0) {
    view.text(x, inner.y + 2, 'no match', { fg: theme.muted, bg: theme.bg });
    blit(buf, view, rect.x, rect.y);
    return;
  }
  const current = clampSelection(palette.selected, entries.length);
  const first = firstRow(current, rows);
  for (let i = 0; i < rows; i += 1) {
    const entry = entries[first + i];
    if (!entry) break;
    const y = inner.y + 2 + i;
    const selected = first + i === current;
    const bg = selected ? theme.panel : theme.bg;
    view.fill({ x: inner.x, y, width: inner.width, height: 1 }, ' ', { bg });
    view.text(x, y, selected ? '▸' : ' ', { fg: theme.accent, bg });
    const meta = `${entry.section} · ${entry.detail}`;
    const titleRoom = Math.max(1, room - 2);
    const title = truncate(entry.title, titleRoom);
    const lit = matchColumns(title, palette.query);
    [...title].forEach((ch, c) => view.text(x + 2 + c, y, ch, { fg: lit.has(c) ? theme.accent : theme.ink, bg, bold: lit.has(c) }));
    // The section and detail sit at the right edge and give way to the title on narrow boxes.
    const metaRoom = room - 2 - [...title].length - 2;
    if (metaRoom >= 8) {
      const text = truncate(meta, metaRoom);
      view.text(x + room - [...text].length, y, text, { fg: theme.muted, bg });
    }
  }
  blit(buf, view, rect.x, rect.y);
}
