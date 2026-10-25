import type { ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';

export interface TabHit {
  index: number;
  x: number;
  width: number;
}

/** "1 Overview  2 Models …" separated by `gap` spaces (two by default) — the active label (digit included) in accent bold, others muted. Returns hit boxes for mouse clicks. */
export function drawTabs(
  buf: ScreenBuffer,
  x: number,
  y: number,
  labels: readonly string[],
  active: number,
  theme: TuiTheme,
  /** Indexes that carry a trailing accent dot: something there wants attention. */
  badged: readonly number[] = [],
  gap = 2,
): TabHit[] {
  const hits: TabHit[] = [];
  let cx = x;
  labels.forEach((label, index) => {
    const text = `${index + 1} ${label}`;
    const style = index === active ? { fg: theme.accent, bold: true } : { fg: theme.muted, bold: false };
    buf.text(cx, y, text, style);
    let width = text.length;
    if (badged.includes(index)) {
      buf.text(cx + width, y, ' •', { fg: theme.accent, bold: false });
      width += 2;
    }
    hits.push({ index, x: cx, width });
    cx += width + gap;
  });
  return hits;
}
