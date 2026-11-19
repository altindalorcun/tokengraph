import { FRAMES } from '../../spinner.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import type { TaskLine, TaskPanel, TaskViewport } from '../task-panel.js';
import type { TuiTheme } from '../theme.js';
import { narrow, narrowChar } from '../text-width.js';
import { drawBox } from '../widgets/box.js';

const PAD = 2; // columns between the border and the text
const MAX_WIDTH = 120;
const MAX_HEIGHT = 44;
const MARGIN_X = 2; // columns left free on each side of the screen, so the box reads as a box over the view
const MARGIN_Y = 1;
const SPINNER_MS = 80;

interface Part {
  text: string;
  fg: string;
  bold?: boolean;
  /** Painted on the accent colour: the text cursor. */
  cursor?: boolean;
}
interface Row {
  parts: Part[];
  highlight?: boolean;
}

const row = (text: string, fg: string, bold = false): Row => ({ parts: [{ text, fg, bold }] });

const BUSY_HINTS = {
  esc: 'It cannot be stopped halfway. You can close the box once it is done.',
  quit: 'It cannot be stopped halfway. Press Ctrl-C again to quit tokengraph.',
} as const;
const blank: Row = { parts: [] };

/** Cuts `word` into pieces of at most `width` columns. */
function chunks(word: string, width: number): string[] {
  const chars = [...word];
  if (chars.length <= width) return [word];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(''));
  return out;
}

/**
 * Word wrap that keeps a line's indentation on its continuation rows and breaks a word wider than the box (a URL,
 * a path) across rows rather than cutting it, so everything a command printed can be read and copied. The text is
 * narrowed first (`text-width.ts`), so one code point is one column and the rows never pass the border.
 */
export function wrapText(raw: string, width: number): string[] {
  const text = narrow(raw);
  const indent = /^ */.exec(text)![0].length;
  const lead = indent < width / 2 ? indent : 0;
  const room = Math.max(1, width - lead);
  const pad = ' '.repeat(lead);
  const words = text.slice(indent).split(' ').flatMap((word) => chunks(word, room));
  const out: string[] = [];
  let current: string | null = null;
  for (const word of words) {
    if (current !== null && [...current].length + 1 + [...word].length <= room) current = `${current} ${word}`;
    else {
      if (current !== null) out.push(pad + current);
      current = word;
    }
  }
  out.push(pad + (current ?? ''));
  return out;
}

/** Leading blank lines dropped and runs of blank lines kept to one: commands space their output for a terminal. */
export function tidyLines(lines: readonly TaskLine[]): TaskLine[] {
  const out: TaskLine[] = [];
  for (const line of lines) {
    const empty = line.text.trim() === '';
    if (empty && (out.length === 0 || out[out.length - 1]!.text.trim() === '')) continue;
    out.push(empty ? { ...line, text: '' } : line);
  }
  return out;
}

function toneColor(tone: TaskLine['tone'], theme: TuiTheme): string {
  return tone === 'err' ? theme.bad : tone === 'input' ? theme.accent : theme.ink;
}

/** The output, wrapped to the box. */
function outputRows(panel: TaskPanel, width: number, theme: TuiTheme): Row[] {
  return tidyLines(panel.lines).flatMap((line) => wrapText(line.text, width).map((text) => row(text, toneColor(line.tone, theme))));
}

/** The part under the output: the open question, the busy line, or how the run ended. */
function statusRows(panel: TaskPanel, width: number, theme: TuiTheme, now: number): Row[] {
  const prompt = panel.prompt;
  if (prompt) {
    const question = wrapText(prompt.question, width).map((text) => row(text, theme.ink, true));
    const choiceText = (choice: string): string => narrow(choice);
    if (prompt.kind === 'confirm') return [...question.slice(0, -1), { parts: [...question.at(-1)!.parts, { text: prompt.defaultYes ? '  [Y/n]' : '  [y/N]', fg: theme.muted }] }];
    if (prompt.kind === 'choice') {
      return [
        ...question,
        ...prompt.choices.map((choice, i): Row => {
          const selected = i === prompt.selected;
          return {
            parts: [{ text: selected ? '▸ ' : '  ', fg: theme.accent }, { text: `${i + 1}) `, fg: theme.muted }, { text: choiceText(choice), fg: theme.ink, bold: selected }],
            highlight: selected,
          };
        }),
      ];
    }
    // The line being typed, scrolled so the cursor stays in view on a long path. The value keeps what was typed
    // (a path must stay exact); only its drawing is narrowed, one column per character, as the cursor counts.
    const room = Math.max(1, width - 2);
    const chars = [...prompt.value].map((char) => narrowChar(char) || '·');
    const start = Math.max(0, prompt.cursor - room + 1);
    const visible = chars.slice(start, start + room);
    const at = prompt.cursor - start;
    const before = visible.slice(0, at).join('');
    const under = visible[at] ?? ' ';
    const after = visible.slice(at + 1).join('');
    return [...question, { parts: [{ text: '› ', fg: theme.accent, bold: true }, { text: before, fg: theme.ink }, { text: under, fg: theme.bg, cursor: true }, { text: after, fg: theme.ink }] }];
  }
  if (panel.status === 'running') {
    const frame = FRAMES[Math.floor(now / SPINNER_MS) % FRAMES.length]!;
    const text = !panel.started ? 'Waiting for the scan to finish…' : panel.cancelling ? 'Cancelling…' : (panel.spinner ?? 'Working…');
    const rows: Row[] = [{ parts: [{ text: `${frame} `, fg: theme.accent }, { text, fg: theme.muted }] }];
    const hint = panel.busyHint === 'quit' && panel.cancelling ? 'Press Ctrl-C again to quit tokengraph.' : panel.busyHint ? BUSY_HINTS[panel.busyHint] : null;
    if (hint) rows.push(...wrapText(hint, width).map((t) => row(t, panel.busyHint === 'quit' ? theme.accent : theme.faint)));
    return rows;
  }
  if (panel.status === 'cancelled') return [{ parts: [{ text: '– ', fg: theme.muted, bold: true }, { text: 'Cancelled', fg: theme.muted, bold: true }] }];
  const ok = panel.status === 'done';
  const rows: Row[] = [{ parts: [{ text: ok ? '✓ ' : '✗ ', fg: ok ? theme.good : theme.bad, bold: true }, { text: ok ? 'Done' : panel.code !== null && panel.code > 0 ? `Failed (exit code ${panel.code})` : 'Failed', fg: ok ? theme.good : theme.bad, bold: true }] }];
  if (panel.after === 'restart') rows.push(...wrapText('The new version is installed. tokengraph starts again when you close this box.', width).map((t) => row(t, theme.ink)));
  if (panel.after === 'quit') rows.push(...wrapText('Your tokengraph data is deleted, so tokengraph closes with this box.', width).map((t) => row(t, theme.ink)));
  return rows;
}

function keys(panel: TaskPanel, scrollable: boolean): (readonly [string, string])[] {
  const scroll = scrollable ? ([['↑↓', ' scroll']] as const) : [];
  const prompt = panel.prompt;
  if (prompt?.kind === 'confirm') return [['y', ' yes'], ['n', ' no'], ['esc', ' cancel'], ...scroll];
  if (prompt?.kind === 'text') return [['enter', ' ok'], ['esc', ' cancel'], ...scroll];
  if (prompt?.kind === 'choice') return [['↑↓', ' choose'], ['enter', ' ok'], ['esc', ' cancel'], ...(scrollable ? [['pgup pgdn', ' scroll'] as const] : [])];
  if (panel.status === 'running' && !panel.started) return [['esc', ' close'], ...scroll];
  if (panel.status === 'running') return [...(panel.cancellable && !panel.cancelling ? [['esc', ' cancel'] as const] : []), ...scroll];
  const close = panel.after === 'restart' ? ' restart tokengraph' : panel.after === 'quit' ? ' quit tokengraph' : ' close';
  return [['enter', close], ...scroll];
}

function drawRows(buf: ScreenBuffer, x: number, y: number, width: number, rows: readonly Row[], theme: TuiTheme, highlight: { x: number; width: number }): void {
  rows.forEach((line, i) => {
    const bg = line.highlight ? theme.panel : theme.bg;
    if (line.highlight) buf.fill({ x: highlight.x, y: y + i, width: highlight.width, height: 1 }, ' ', { bg });
    let cx = x;
    for (const part of line.parts) {
      const room = x + width - cx;
      if (room <= 0) break;
      cx += buf.text(cx, y + i, part.text, { fg: part.fg, bg: part.cursor ? theme.accent : bg, bold: part.bold ?? false }, room);
    }
  });
}

/**
 * The task box over the whole screen: the action's output as it is printed (following the newest line until the
 * person scrolls up), then the open question, the busy line or how it ended, then its keys. Returns the rows the
 * output gets and fills, so the next key can scroll within them.
 */
export function drawTask(buf: ScreenBuffer, rect: Rect, panel: TaskPanel, theme: TuiTheme, now: number): TaskViewport {
  const width = Math.max(10, Math.min(MAX_WIDTH, rect.width - MARGIN_X * 2));
  const height = Math.max(8, Math.min(MAX_HEIGHT, rect.height - MARGIN_Y * 2));
  const box = { x: rect.x + Math.floor((rect.width - width) / 2), y: rect.y + Math.floor((rect.height - height) / 2), width, height };
  buf.fill(box, ' ', { fg: theme.ink, bg: theme.bg });
  const inner = drawBox(buf, box, theme, narrow(panel.title));
  const textWidth = Math.max(1, inner.width - PAD * 2);
  const x = inner.x + PAD;

  // Rows: blank, output, rule, status, blank, keys. The status keeps what it needs; the output takes the rest.
  const status = statusRows(panel, textWidth, theme, now);
  const statusHeight = Math.min(status.length, Math.max(1, inner.height - 5));
  const bodyRows = Math.max(1, inner.height - 4 - statusHeight);
  const output = outputRows(panel, textWidth, theme);
  const max = Math.max(0, output.length - bodyRows);
  const top = panel.follow ? max : Math.min(panel.scroll, max);
  const bodyY = inner.y + 1;
  drawRows(buf, x, bodyY, textWidth, output.slice(top, top + bodyRows), theme, { x: inner.x, width: inner.width });
  const below = output.length - (top + bodyRows);
  if (below > 0) {
    const label = ` ↓ ${below} more `;
    buf.text(inner.x + inner.width - PAD - [...label].length, bodyY + bodyRows - 1, label, { fg: theme.muted, bg: theme.panel });
  }
  if (top > 0) {
    const label = ` ↑ ${top} more `;
    buf.text(inner.x + inner.width - PAD - [...label].length, bodyY, label, { fg: theme.muted, bg: theme.panel });
  }

  const ruleY = bodyY + bodyRows;
  buf.fill({ x: inner.x, y: ruleY, width: inner.width, height: 1 }, '─', { fg: theme.border, bg: theme.bg });
  // A long question keeps its end (the input line or the answers) when the box is short.
  drawRows(buf, x, ruleY + 1, textWidth, status.slice(status.length - statusHeight), theme, { x: inner.x, width: inner.width });

  const keysY = inner.y + inner.height - 1;
  let cx = x;
  for (const [key, label] of keys(panel, output.length > bodyRows)) {
    cx += buf.text(cx, keysY, key, { fg: theme.accent, bg: theme.bg, bold: true });
    cx += buf.text(cx, keysY, label, { fg: theme.muted, bg: theme.bg });
    cx += 2;
  }
  return { rows: bodyRows, total: output.length };
}
