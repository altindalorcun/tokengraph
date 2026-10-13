import type { ScreenBuffer } from '../screen.js';

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** A horizontal bar of `fraction` (0..1) of `width` columns with eighth-block precision; the rest is left untouched. */
export function drawBar(buf: ScreenBuffer, x: number, y: number, width: number, fraction: number, color: string): void {
  if (!(width > 0) || !Number.isFinite(fraction)) return;
  const clamped = Math.min(1, Math.max(0, fraction));
  const eighths = Math.round(clamped * Math.floor(width) * 8);
  const full = Math.floor(eighths / 8);
  for (let i = 0; i < full; i++) buf.set(x + i, y, '█', { fg: color });
  const part = eighths % 8;
  if (part > 0) buf.set(x + full, y, EIGHTHS[part]!, { fg: color });
}

export interface Segment {
  fraction: number;
  color: string;
}

/** Consecutive segments filling `width` columns (whole cells, largest remainder rounding; tiny non-zero segments get at least 1 column when width allows). */
export function drawStackedBar(buf: ScreenBuffer, x: number, y: number, width: number, segments: readonly Segment[]): void {
  const w = Math.floor(width);
  if (!(w > 0)) return;
  const fractions = segments.map((s) => (Number.isFinite(s.fraction) && s.fraction > 0 ? s.fraction : 0));
  const total = fractions.reduce((a, b) => a + b, 0);
  if (total <= 0) return;
  // Normalise so the segments fill the bar; fractions summing to < 1 would otherwise leave a gap.
  const exact = fractions.map((f) => (f / total) * w);
  const cols = exact.map(Math.floor);
  const order = exact.map((e, i) => ({ i, rem: e - Math.floor(e) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  let left = w - cols.reduce((a, b) => a + b, 0);
  for (const { i } of order) {
    if (left <= 0) break;
    if (fractions[i]! > 0) {
      cols[i]!++;
      left--;
    }
  }
  // Tiny non-zero segments rounded to nothing take a column from the widest one.
  const nonZero = fractions.filter((f) => f > 0).length;
  if (w >= nonZero) {
    for (let i = 0; i < cols.length; i++) {
      if (fractions[i]! > 0 && cols[i] === 0) {
        let widest = 0;
        for (let j = 1; j < cols.length; j++) if (cols[j]! > cols[widest]!) widest = j;
        cols[widest]!--;
        cols[i] = 1;
      }
    }
  }
  let cx = x;
  segments.forEach((segment, i) => {
    for (let k = 0; k < cols[i]!; k++) buf.set(cx++, y, '█', { fg: segment.color });
  });
}
