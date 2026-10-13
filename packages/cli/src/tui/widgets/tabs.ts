import type { ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';

export interface TabHit {
  index: number;
  x: number;
  width: number;
}

/** "1 Overview  2 Models …" separated by two spaces — the active label (digit included) in accent bold, others muted. Returns hit boxes for mouse clicks. */
export function drawTabs(
  buf: ScreenBuffer,
  x: number,
  y: number,
  labels: readonly string[],
  active: number,
  theme: TuiTheme,
): TabHit[] {
  const hits: TabHit[] = [];
  let cx = x;
  labels.forEach((label, index) => {
    const text = `${index + 1} ${label}`;
    const style = index === active ? { fg: theme.accent, bold: true } : { fg: theme.muted, bold: false };
    buf.text(cx, y, text, style);
    hits.push({ index, x: cx, width: text.length });
    cx += text.length + 2;
  });
  return hits;
}
