import { formatTokens } from '@tokengraph/core';
import type { MergeReason } from '../../project-names.js';
import { renameTarget, shownCandidates, type MergePanel, type ProjectPanel, type RenamePanel, type SplitPanel } from '../project-panel.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { wrap } from './confirm.js';
import { truncate } from './dates.js';

const PAD = 2; // columns between the border and the text
const TEXT_WIDTH = 56;
const MAX_LIST = 12; // candidate rows shown at once; more scroll
const MAX_FOLDERS = 8;
const TOKENS_W = 7;
const FOLDERS_W = 10; // "12 folders"
const MARK = '●';

interface Part {
  text: string;
  fg: string;
  bg?: string;
  bold?: boolean;
}
interface Line {
  parts: Part[];
  /** Drawn on the panel colour across the box: the selected row of a list, or the text field. */
  highlight?: boolean;
}

const TITLES = { merge: 'Merge projects', rename: 'Rename project', split: 'Split project' } as const;
const REASONS: Record<MergeReason, string> = {
  'same-name': 'Same name, ignoring case and parts like -cli',
  'parent-name': 'One sits in a folder named like the other',
  'similar-name': 'One name holds the other',
  'same-folder': 'Its folder sits next to this one',
};

const plain = (text: string, fg: string, bold = false): Line => ({ parts: [{ text, fg, bold }] });
const blank: Line = { parts: [] };
const quoted = (name: string): string => `"${name}"`;

/** Cuts a word wider than `width` into rows, so a long name or folder is shown whole rather than shortened. */
function chunks(word: string, width: number): string[] {
  const chars = [...word];
  if (chars.length <= width) return [word];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(''));
  return out;
}
const wrapped = (text: string, width: number, fg: string, bold = false): Line[] =>
  wrap(text.split(' ').flatMap((word) => chunks(word, width)).join(' '), width).map((line) => plain(line, fg, bold));

const folderCount = (n: number): string => (n === 1 ? '1 folder' : `${n} folders`);

/** What a box shows: fixed lines above, a list that takes the rows left (and scrolls), fixed lines below, and its keys. */
interface Layout {
  head: Line[];
  list: Line[];
  /** The list row to keep in view. */
  focus: number;
  /** True when the list scrolls round `focus`; false cuts a long list short with "+ n more". */
  scroll: boolean;
  tail: Line[];
  keys: (readonly [string, string])[];
}

function candidateLine(panel: MergePanel, index: number, width: number, theme: TuiTheme): Line {
  const candidate = shownCandidates(panel)[index]!;
  const selected = index === panel.selected;
  // Narrow boxes give up the folder count, then the tokens, before the name.
  const showFolders = width >= 4 + 12 + 2 + TOKENS_W + 2 + FOLDERS_W;
  const showTokens = width >= 4 + 12 + 2 + TOKENS_W;
  const nameW = Math.max(1, width - 4 - (showTokens ? 2 + TOKENS_W : 0) - (showFolders ? 2 + FOLDERS_W : 0));
  const parts: Part[] = [
    { text: selected ? '▸ ' : '  ', fg: theme.accent },
    { text: candidate.reason ? `${MARK} ` : '  ', fg: theme.accent },
    { text: truncate(candidate.name, nameW).padEnd(nameW), fg: theme.ink, bold: selected },
  ];
  if (showTokens) parts.push({ text: `  ${formatTokens(candidate.weighted).padStart(TOKENS_W)}`, fg: theme.ink });
  if (showFolders) parts.push({ text: `  ${folderCount(candidate.folders).padStart(FOLDERS_W)}`, fg: theme.muted });
  return { parts, highlight: selected };
}

function mergeLayout(panel: MergePanel, width: number, theme: TuiTheme): Layout {
  if (panel.confirm) {
    const { other, keep } = panel.confirm;
    const picked = panel.candidates.find((candidate) => candidate.name === other);
    const tokens = panel.weighted + (picked?.weighted ?? 0);
    const folders = panel.folders + (picked?.folders ?? 0);
    const option = (name: string, kept: boolean): Line => ({
      parts: [{ text: kept ? '▸ ' : '  ', fg: theme.accent }, { text: name, fg: theme.ink, bold: kept }],
      highlight: kept,
    });
    return {
      head: [
        ...wrapped(`${quoted(panel.project)} and ${quoted(other)} will count as one project.`, width, theme.ink, true),
        ...wrapped(`Together: ${formatTokens(tokens)} tokens, ${folderCount(folders)}.`, width, theme.muted),
        blank,
        plain('Keep the name', theme.muted),
        option(panel.project, keep === 'project'),
        option(other, keep === 'other'),
      ],
      list: [],
      focus: 0,
      scroll: true,
      tail: [],
      keys: [['←→', ' choose name'], ['enter', ' merge'], ['esc', ' back']],
    };
  }

  const shown = shownCandidates(panel);
  const filter: Line = {
    parts: [
      { text: 'Filter ', fg: theme.muted },
      { text: panel.filter, fg: theme.ink },
      { text: ' ', fg: theme.bg, bg: theme.accent },
      { text: panel.filter === '' ? ' type a name' : '', fg: theme.faint },
    ],
  };
  const list = shown.length > 0 ? shown.map((_, index) => candidateLine(panel, index, width, theme)) : wrapped(`No project matches ${quoted(panel.filter)}.`, width, theme.muted);
  const selected = shown[panel.selected];
  const tail: Line[] = [];
  if (selected?.reason) tail.push(blank, { parts: [{ text: `${MARK} `, fg: theme.accent }, { text: truncate(REASONS[selected.reason], width - 2), fg: theme.muted }] });
  else if (panel.candidates.some((candidate) => candidate.reason !== null)) tail.push(blank, { parts: [{ text: `${MARK} `, fg: theme.accent }, { text: 'Likely the same project', fg: theme.muted }] });
  return {
    head: [...wrapped(`Merge ${quoted(panel.project)} with…`, width, theme.ink, true), filter, blank],
    list,
    focus: shown.length > 0 ? panel.selected : 0,
    scroll: true,
    tail,
    keys: [['↑↓', ' choose'], ['enter', ' pick'], ['esc', ' close']],
  };
}

/** The text field: the name scrolled so the cursor stays in view, the cursor drawn as an accent cell. */
function fieldLine(panel: RenamePanel, width: number, theme: TuiTheme): Line {
  const chars = [...panel.text];
  const room = Math.max(1, width);
  const start = Math.max(0, panel.cursor - (room - 1));
  const before = chars.slice(start, panel.cursor).join('');
  const under = chars[panel.cursor] ?? ' ';
  const after = chars.slice(panel.cursor + 1, start + room).join('');
  return {
    parts: [
      { text: before, fg: theme.ink },
      { text: under, fg: theme.bg, bg: theme.accent },
      { text: after, fg: theme.ink },
    ],
    highlight: true,
  };
}

function renameLayout(panel: RenamePanel, width: number, theme: TuiTheme): Layout {
  const target = renameTarget(panel);
  let note: Line[];
  if (panel.error) note = wrapped(panel.error, width, theme.bad);
  else if (target?.merges) note = wrapped(`${quoted(target.name)} is another project, so they will count as one.`, width, theme.accent);
  else note = wrapped('Folders with one name count as one project.', width, theme.muted);
  return {
    head: [...wrapped(`Rename ${quoted(panel.project)}`, width, theme.ink, true), blank, fieldLine(panel, width, theme), blank, ...note],
    list: [],
    focus: 0,
    scroll: true,
    tail: [],
    keys: [['enter', target?.merges ? ' merge' : ' rename'], ['esc', ' cancel']],
  };
}

function splitLayout(panel: SplitPanel, width: number, theme: TuiTheme): Layout {
  return {
    head: [
      ...wrapped(`Split ${quoted(panel.project)} back into its folders?`, width, theme.ink, true),
      ...wrapped('Each folder becomes its own project again:', width, theme.muted),
      blank,
    ],
    list: panel.folders.flatMap((folder) => chunks(folder, Math.max(1, width - 2)).map((row, i) => ({ parts: [{ text: i === 0 ? '· ' : '  ', fg: theme.faint }, { text: row, fg: theme.ink }] }))),
    focus: 0,
    scroll: false,
    tail: [],
    keys: [['enter', ' split'], ['esc', ' cancel']],
  };
}

function layout(panel: ProjectPanel, width: number, theme: TuiTheme): Layout {
  switch (panel.kind) {
    case 'merge':
      return mergeLayout(panel, width, theme);
    case 'rename':
      return renameLayout(panel, width, theme);
    case 'split':
      return splitLayout(panel, width, theme);
  }
}

/** The list rows that fit in `rows`: a window round the focused row, or the first ones and "+ n more". */
function visible(lay: Layout, rows: number, theme: TuiTheme): Line[] {
  if (lay.list.length <= rows) return lay.list;
  if (rows <= 0) return [];
  if (!lay.scroll) return [...lay.list.slice(0, rows - 1), plain(`+ ${lay.list.length - rows + 1} more`, theme.muted)];
  const start = Math.min(Math.max(0, lay.focus - Math.floor(rows / 2)), lay.list.length - rows);
  return lay.list.slice(start, start + rows);
}

function drawLines(buf: ScreenBuffer, x: number, y: number, width: number, lines: readonly Line[], maxRows: number, theme: TuiTheme, highlight: { x: number; width: number }): void {
  lines.slice(0, Math.max(0, maxRows)).forEach((line, i) => {
    const bg = line.highlight ? theme.panel : theme.bg;
    if (line.highlight) buf.fill({ x: highlight.x, y: y + i, width: highlight.width, height: 1 }, ' ', { bg });
    let cx = x;
    for (const part of line.parts) {
      const room = x + width - cx;
      if (room <= 0) break;
      cx += buf.text(cx, y + i, truncate(part.text, room), { fg: part.fg, bg: part.bg ?? bg, bold: part.bold ?? false }, room);
    }
  });
}

/** The merge, rename or split box, centred on `rect`. Keys sit on its last row; a short screen shortens the list first. */
export function drawProjectPanel(buf: ScreenBuffer, rect: Rect, panel: ProjectPanel, theme: TuiTheme): void {
  const textWidth = Math.max(1, Math.min(TEXT_WIDTH, rect.width - 2 - PAD * 2));
  const lay = layout(panel, textWidth, theme);
  // Border, blank, head, list, tail, blank, keys, border.
  const fixed = lay.head.length + lay.tail.length + 5;
  const wanted = Math.min(lay.list.length, lay.scroll ? MAX_LIST : MAX_FOLDERS);
  const listRows = Math.max(0, Math.min(wanted, rect.height - fixed));
  const lines = [...lay.head, ...visible(lay, listRows, theme), ...lay.tail];

  const width = Math.min(rect.width, 2 + PAD * 2 + textWidth);
  const height = Math.min(rect.height, lines.length + 5);
  const box = { x: rect.x + Math.floor((rect.width - width) / 2), y: rect.y + Math.floor((rect.height - height) / 2), width, height };
  buf.fill(box, ' ', { fg: theme.ink, bg: theme.bg });
  const inner = drawBox(buf, box, theme, TITLES[panel.kind]);
  drawLines(buf, inner.x + PAD, inner.y + 1, textWidth, lines, inner.height - 3, theme, { x: inner.x, width: inner.width });

  if (inner.height < 1) return;
  const keysY = inner.y + inner.height - 1;
  const end = inner.x + inner.width;
  let cx = inner.x + PAD;
  for (const [key, label] of lay.keys) {
    if (cx >= end) break;
    cx += buf.text(cx, keysY, key, { fg: theme.accent, bg: theme.bg, bold: true }, end - cx);
    cx += buf.text(cx, keysY, label, { fg: theme.muted, bg: theme.bg }, Math.max(0, end - cx));
    cx += 2;
  }
}
