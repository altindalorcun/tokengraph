import { ScreenBuffer, type Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { truncate } from './dates.js';
import { blit } from './props.js';

const BOX_WIDTH = 54;
const PADDING = 2; // columns between the border and the text

/** Greedy word wrap to `width` columns; a word wider than that is cut with an ellipsis. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1];
    if (last !== undefined && [...last].length + 1 + [...word].length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(truncate(word, width));
  }
  return lines;
}

/** A centred question box over the view: the wrapped text, then `y yes  n no` on its last row. */
export function drawConfirm(buf: ScreenBuffer, rect: Rect, text: string, theme: TuiTheme): void {
  const view = new ScreenBuffer(rect.width, rect.height);
  const width = Math.min(view.width, BOX_WIDTH);
  const room = Math.max(1, width - 2 - PADDING * 2);
  const lines = wrap(text, room);
  // Rows: border, blank, text, blank, keys, border.
  const height = Math.min(view.height, lines.length + 5);
  const box = { x: Math.floor((view.width - width) / 2), y: Math.floor((view.height - height) / 2), width, height };
  view.fill(box, ' ', { bg: theme.panel });
  const inner = drawBox(view, box, theme, 'Confirm');
  const x = inner.x + PADDING;
  lines.forEach((line, i) => view.text(x, inner.y + 1 + i, line, { fg: theme.ink }, room));
  const keys = inner.y + inner.height - 1;
  let cx = x;
  for (const [key, label] of [['y', ' yes'], ['n', ' no']] as const) {
    cx += view.text(cx, keys, key, { fg: theme.accent, bold: true });
    cx += view.text(cx, keys, label, { fg: theme.ink });
    cx += 2;
  }
  blit(buf, view, rect.x, rect.y);
}
