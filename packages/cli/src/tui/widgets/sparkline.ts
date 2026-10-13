import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** One row of ▁▂▃▄▅▆▇█ scaled to the max of `values` (zero → '·' faint); the last `width` values when longer. */
export function drawSparkline(
  buf: ScreenBuffer,
  x: number,
  y: number,
  width: number,
  values: readonly number[],
  color: string,
  theme: TuiTheme,
): void {
  const w = Math.floor(width);
  if (!(w > 0)) return;
  const shown = values.length > w ? values.slice(values.length - w) : values;
  const max = Math.max(0, ...shown.filter(Number.isFinite));
  shown.forEach((v, i) => {
    if (!(v > 0) || max <= 0) {
      buf.set(x + i, y, '·', { fg: theme.faint });
      return;
    }
    const level = Math.min(8, Math.max(1, Math.ceil((v / max) * 8)));
    buf.set(x + i, y, LEVELS[level - 1]!, { fg: color });
  });
}

/** Vertical bars `height` rows tall using eighth blocks (▁..█) per column, one column per value with `gap` spaces between. */
export function drawColumns(buf: ScreenBuffer, rect: Rect, values: readonly number[], colors: readonly string[], gap: number): void {
  if (rect.height <= 0 || rect.width <= 0) return;
  const max = Math.max(0, ...values.filter(Number.isFinite));
  if (max <= 0) return;
  const step = 1 + Math.max(0, Math.floor(gap));
  const bottom = rect.y + rect.height - 1;
  values.forEach((v, i) => {
    const col = i * step;
    if (col >= rect.width || !(v > 0)) return;
    const color = colors[i] ?? colors[colors.length - 1];
    if (color === undefined) return;
    const eighths = Math.max(1, Math.round((v / max) * rect.height * 8));
    const full = Math.floor(eighths / 8);
    const part = eighths % 8;
    for (let r = 0; r < full; r++) buf.set(rect.x + col, bottom - r, '█', { fg: color });
    if (part > 0 && full < rect.height) buf.set(rect.x + col, bottom - full, LEVELS[part - 1]!, { fg: color });
  });
}
