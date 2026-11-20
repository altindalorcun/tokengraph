import { STORY_RANGE_LABELS, STORY_RANGES, type StoryRange } from '@tokengraph/core';
import type { Rect, ScreenBuffer } from '../screen.js';
import { canSave, type StoryCardRow, type StoryPanel } from '../story-panel.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { wrap } from './confirm.js';
import { truncate } from './dates.js';

const PAD = 2; // columns between the border and the text
const TEXT_WIDTH = 46; // the text column when no QR code is shown
const SIDE_MIN = 26; // the text column beside the QR code
const SIDE_MAX = 38;
const GAP = 3; // columns between the QR code and the text
const QUIET = 2; // white modules round the code; phones need a margin to find it
const QR_DARK = '#000000';
const QR_LIGHT = '#ffffff';

interface Part {
  text: string;
  fg: string;
  bold?: boolean;
}
interface Line {
  parts: Part[];
  /** The selected row of a list, drawn on the panel colour across the box. */
  highlight?: boolean;
}

const STOP_TEXT = {
  'all-saved': 'All cards saved. Stopped sharing.',
  idle: 'No activity for 10 minutes. Stopped sharing.',
  stopped: 'Stopped sharing.',
} as const;

function periodTitle(range: StoryRange): string {
  return range === 'today' ? 'Today' : `Last ${STORY_RANGE_LABELS[range]}`;
}

const plain = (text: string, fg: string, bold = false): Line => ({ parts: [{ text, fg, bold }] });
const blank: Line = { parts: [] };
/** Cuts a word wider than `width` into rows, so an address or a folder is shown whole rather than shortened. */
function chunks(word: string, width: number): string[] {
  const chars = [...word];
  if (chars.length <= width) return [word];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(''));
  return out;
}
const wrapped = (text: string, width: number, fg: string): Line[] =>
  wrap(text.split(' ').flatMap((word) => chunks(word, width)).join(' '), width).map((line) => plain(line, fg));

function cardLine(card: StoryCardRow, theme: TuiTheme): Line {
  switch (card.status) {
    case 'waiting':
      return { parts: [{ text: `· ${card.title}`, fg: theme.faint }] };
    case 'drawing':
      return { parts: [{ text: '… ', fg: theme.accent }, { text: card.title, fg: theme.ink }, { text: '  drawing', fg: theme.muted }] };
    case 'ready':
      return { parts: [{ text: '✓ ', fg: theme.good }, { text: card.title, fg: theme.ink }] };
    case 'downloaded':
      return { parts: [{ text: '✓ ', fg: theme.good }, { text: card.title, fg: theme.ink }, { text: '  on your phone', fg: theme.good }] };
  }
}

/** The text column: the period, the cards, then how the hand-off stands and whether the cards were saved. */
function textLines(panel: StoryPanel, width: number, theme: TuiTheme, qrNeed: { width: number; height: number } | null): Line[] {
  if (panel.step === 'range') {
    return [
      plain('Which period should the cards cover?', theme.ink, true),
      blank,
      ...STORY_RANGES.map((range, i): Line => {
        const selected = i === panel.selected;
        return { parts: [{ text: selected ? '▸ ' : '  ', fg: theme.accent }, { text: periodTitle(range), fg: theme.ink, bold: selected }], highlight: selected };
      }),
    ];
  }
  const lines: Line[] = [];
  const title = panel.range ? periodTitle(panel.range) : '';
  lines.push({ parts: [{ text: title, fg: theme.ink, bold: true }, { text: panel.handle ? `  @${panel.handle}` : '', fg: theme.muted }] });
  lines.push(blank);
  for (const card of panel.cards) lines.push(cardLine(card, theme));
  if (panel.empty) lines.push(blank, ...wrapped('No usage in this period yet, so the cards show 0.', width, theme.muted));
  if (panel.step === 'failed') {
    lines.push(blank, ...wrapped(panel.error ?? 'Could not draw the cards.', width, theme.bad));
    return lines;
  }
  if (panel.step === 'drawing') return lines;

  lines.push(blank);
  const share = panel.share;
  switch (share.state) {
    case 'starting':
      lines.push(plain('Starting to share…', theme.muted));
      break;
    case 'live':
      if (qrNeed) {
        lines.push(...wrapped(`Make the window at least ${qrNeed.width}×${qrNeed.height} to show the QR code.`, width, theme.accent));
        lines.push(blank, plain('Or open this address on your phone:', theme.muted));
        lines.push(...chunks(share.url, width).map((row) => plain(row, theme.ink)));
      } else {
        lines.push(plain("Scan with your phone's camera", theme.ink, true));
        lines.push(...chunks(share.url, width).map((row) => plain(row, theme.muted)));
        lines.push(blank, ...wrapped('Your phone and this computer must be on the same Wi-Fi.', width, theme.muted));
      }
      if (share.phone) lines.push(blank, { parts: [{ text: '● ', fg: theme.good }, { text: 'Phone connected', fg: theme.ink }] });
      break;
    case 'offline':
      lines.push(...wrapped('No Wi-Fi or Ethernet network found, so a phone cannot reach this computer.', width, theme.bad));
      break;
    case 'failed':
      lines.push(...wrapped(share.reason, width, theme.bad));
      break;
    case 'stopped':
      lines.push(plain(STOP_TEXT[share.reason], theme.muted));
      break;
  }

  const save = panel.save;
  if (save.state === 'saving') lines.push(blank, plain('Saving…', theme.muted));
  else if (save.state === 'saved') lines.push(blank, ...wrapped(`✓ Saved to ${save.dir}`, width, theme.good));
  else if (save.state === 'failed') lines.push(blank, ...wrapped(save.reason, width, theme.bad));
  return lines;
}

function keys(panel: StoryPanel): (readonly [string, string])[] {
  if (panel.step === 'range') return [['↑↓', ' choose'], ['enter', ' make cards'], ['esc', ' close']];
  if (panel.step === 'drawing') return [['esc', ' cancel']];
  return canSave(panel) ? [['s', ' save to this computer'], ['esc', ' close']] : [['esc', ' close']];
}

function drawLines(buf: ScreenBuffer, x: number, y: number, width: number, lines: readonly Line[], maxRows: number, theme: TuiTheme, highlight: { x: number; width: number }): void {
  lines.slice(0, maxRows).forEach((line, i) => {
    const bg = line.highlight ? theme.panel : theme.bg;
    if (line.highlight) buf.fill({ x: highlight.x, y: y + i, width: highlight.width, height: 1 }, ' ', { bg });
    let cx = x;
    for (const part of line.parts) {
      const room = x + width - cx;
      if (room <= 0) break;
      cx += buf.text(cx, y + i, truncate(part.text, room), { fg: part.fg, bg, bold: part.bold ?? false }, room);
    }
  });
}

/**
 * Dark modules in black, light in white whatever the theme, since a phone reads dark on light. Two
 * module rows per cell: a cell whose halves match is a painted space, a mixed one is ▄ over the top
 * module's colour, so terminals that leave a strip under block glyphs still show a clean code.
 */
function drawQr(buf: ScreenBuffer, x: number, y: number, matrix: readonly boolean[][]): void {
  const size = matrix.length + QUIET * 2;
  const dark = (row: number, col: number): boolean => {
    const r = row - QUIET;
    const c = col - QUIET;
    return r >= 0 && c >= 0 && r < matrix.length && c < matrix.length && matrix[r]![c]!;
  };
  for (let row = 0; row < size; row += 2) {
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      const cx = x + col;
      const cy = y + row / 2;
      if (top === bottom) buf.set(cx, cy, ' ', { bg: top ? QR_DARK : QR_LIGHT });
      else buf.set(cx, cy, '▄', { fg: bottom ? QR_DARK : QR_LIGHT, bg: top ? QR_DARK : QR_LIGHT, bold: false, dim: false });
    }
  }
}

/** The story cards box, centred on `rect`: the text column, and beside it the QR code while sharing when it fits. */
export function drawStory(buf: ScreenBuffer, rect: Rect, panel: StoryPanel, theme: TuiTheme): void {
  const share = panel.share;
  const qr = panel.step === 'ready' && share.state === 'live' ? share.qr : null;
  const qrSize = qr ? qr.length + QUIET * 2 : 0;
  const qrRows = Math.ceil(qrSize / 2);
  // Border + padding + code + gap + text + padding + border, and border + blank + rows + blank + keys + border.
  const sideRoom = rect.width - (2 + PAD * 2 + qrSize + GAP);
  const side = Math.min(SIDE_MAX, sideRoom);
  let qrNeed: { width: number; height: number } | null = null;
  let lines: Line[];
  let showQr = false;
  if (qr) {
    lines = textLines(panel, Math.max(SIDE_MIN, side), theme, null);
    const height = 5 + Math.max(qrRows, lines.length);
    showQr = side >= SIDE_MIN && height <= rect.height;
    if (!showQr) qrNeed = { width: 2 + PAD * 2 + qrSize + GAP + SIDE_MIN, height };
  }
  const textWidth = showQr ? side : Math.max(1, Math.min(TEXT_WIDTH, rect.width - 2 - PAD * 2));
  lines = textLines(panel, textWidth, theme, qrNeed);

  const bodyRows = showQr ? Math.max(qrRows, lines.length) : lines.length;
  const width = Math.min(rect.width, 2 + PAD * 2 + (showQr ? qrSize + GAP : 0) + textWidth);
  const height = Math.min(rect.height, bodyRows + 5);
  const box = { x: rect.x + Math.floor((rect.width - width) / 2), y: rect.y + Math.floor((rect.height - height) / 2), width, height };
  buf.fill(box, ' ', { fg: theme.ink, bg: theme.bg });
  const inner = drawBox(buf, box, theme, 'Story cards');
  const top = inner.y + 1;
  const rows = Math.max(0, inner.height - 3);
  let textX = inner.x + PAD;
  if (showQr && qr) {
    drawQr(buf, inner.x + PAD, top, qr);
    textX += qrSize + GAP;
  }
  drawLines(buf, textX, top, textWidth, lines, rows, theme, { x: inner.x, width: inner.width });

  const keysY = inner.y + inner.height - 1;
  let cx = inner.x + PAD;
  for (const [key, label] of keys(panel)) {
    cx += buf.text(cx, keysY, key, { fg: theme.accent, bg: theme.bg, bold: true });
    cx += buf.text(cx, keysY, label, { fg: theme.muted, bg: theme.bg });
    cx += 2;
  }
}
