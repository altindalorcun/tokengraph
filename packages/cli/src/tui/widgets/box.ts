import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';

/** Rounded box (╭─╮ │ ╰─╯) in theme.border with an optional title inset at x+2 (" TITLE ", muted, bold). Returns the inner rect. */
export function drawBox(buf: ScreenBuffer, rect: Rect, theme: TuiTheme, title?: string): Rect {
  const { x, y, width, height } = rect;
  const inner: Rect = { x: x + 1, y: y + 1, width: Math.max(0, width - 2), height: Math.max(0, height - 2) };
  if (width < 2 || height < 2) return inner;
  const style = { fg: theme.border };
  const right = x + width - 1;
  const bottom = y + height - 1;
  buf.set(x, y, '╭', style);
  buf.set(right, y, '╮', style);
  buf.set(x, bottom, '╰', style);
  buf.set(right, bottom, '╯', style);
  for (let cx = x + 1; cx < right; cx++) {
    buf.set(cx, y, '─', style);
    buf.set(cx, bottom, '─', style);
  }
  for (let cy = y + 1; cy < bottom; cy++) {
    buf.set(x, cy, '│', style);
    buf.set(right, cy, '│', style);
  }
  if (title) {
    // Clipped so a long title never overwrites the top-right corner.
    const room = width - 4;
    if (room > 0) buf.text(x + 2, y, ` ${title.toUpperCase()} `, { fg: theme.muted, bold: true }, room);
  }
  return inner;
}
