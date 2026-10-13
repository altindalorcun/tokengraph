import type { Rect, ScreenBuffer } from '../screen.js';

export interface StackedColumn {
  /** Bottom-up segments; non-positive or non-finite values count as zero. */
  segments: { value: number; color: string }[];
  /** Marks the column with a ▾ above it. */
  highlight?: boolean;
}

// Lower-eighths glyphs, indexed by eighths - 1.
const EIGHTHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];

const amount = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** Splits `total` whole eighths between `values` proportionally; largest remainder so the parts sum to `total`. */
function splitEighths(values: readonly number[], total: number): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / sum) * total);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, rest: e - Math.floor(e) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}

/** Vertical stacked columns, one per entry, `width` columns each with `gap` between, scaled to the tallest column. */
export function drawStackedColumns(
  buf: ScreenBuffer,
  rect: Rect,
  columns: readonly StackedColumn[],
  options: { width: number; gap: number; emptyColor: string; highlightColor: string },
): void {
  const width = Math.max(1, Math.floor(options.width));
  const stride = width + Math.max(0, Math.floor(options.gap));
  if (!(rect.width > 0) || !(rect.height > 0)) return;
  const bottom = rect.y + rect.height - 1;
  const totals = columns.map((c) => c.segments.reduce((sum, s) => sum + amount(s.value), 0));
  const max = Math.max(0, ...totals);

  columns.forEach((column, i) => {
    const left = rect.x + i * stride;
    if (left + width > rect.x + rect.width) return;
    const put = (row: number, ch: string, fg: string, bg?: string) => {
      if (row < rect.y || row > bottom) return;
      for (let dx = 0; dx < width; dx++) buf.set(left + dx, row, ch, bg === undefined ? { fg } : { fg, bg });
    };

    const total = totals[i]!;
    // A non-empty column always shows at least one eighth so a tiny day is not mistaken for a zero day.
    const height = total > 0 && max > 0 ? Math.min(rect.height * 8, Math.max(1, Math.round((total / max) * rect.height * 8))) : 0;
    if (height === 0) {
      put(bottom, '▁', options.emptyColor);
      if (column.highlight) put(bottom - 1, '▾', options.highlightColor);
      return;
    }

    const segments = column.segments.filter((s) => amount(s.value) > 0);
    const parts = splitEighths(segments.map((s) => amount(s.value)), height);
    // ends[k] = eighth (exclusive) where segment k stops, counted from the bottom.
    const ends: number[] = [];
    parts.reduce((acc, p, k) => (ends[k] = acc + p), 0);
    const segmentAt = (eighth: number): number => ends.findIndex((end, k) => parts[k]! > 0 && eighth < end);

    const rows = Math.ceil(height / 8);
    for (let r = 0; r < rows; r++) {
      const filled = Math.min(8, height - 8 * r);
      const lo = segmentAt(8 * r);
      const hi = segmentAt(8 * r + filled - 1);
      const loColor = segments[lo]!.color;
      if (lo === hi) {
        put(bottom - r, filled === 8 ? '█' : EIGHTHS[filled - 1]!, loColor);
      } else if (filled < 8) {
        // The column ends inside this cell: no bg, or the empty eighths above it would be painted.
        put(bottom - r, EIGHTHS[filled - 1]!, segments[hi]!.color);
      } else {
        // A cell holding 3+ segments keeps only the lowest and the topmost.
        put(bottom - r, EIGHTHS[ends[lo]! - 8 * r - 1]!, loColor, segments[hi]!.color);
      }
    }
    if (column.highlight) put(bottom - rows, '▾', options.highlightColor);
  });
}
