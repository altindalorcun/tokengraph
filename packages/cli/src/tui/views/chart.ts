import { formatTokens } from '@tokengraph/core';
import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { drawStackedColumns } from '../widgets/stacked-columns.js';

const MAX_COLUMN_WIDTH = 8; // a handful of buckets should not turn into slabs
const LABEL_SPACING = 2;
/** Smallest rect worth a chart: border, legend row, three rows of columns, label row, border. */
export const CHART_MIN_HEIGHT = 8;

export interface ChartColumn {
  segments: { value: number; color: string; /** Matches a legend item's key. */ key?: string }[];
  /** Printed under the column when there is room. */
  label: string;
  highlight?: boolean;
}

export interface ChartOptions {
  title: string;
  columns: readonly ChartColumn[];
  /** `■ name` items on the first inner row. */
  legend?: readonly { text: string; color: string; key: string }[];
}

/** Column width and gap for `count` columns in `room` cells: a gap of 1 when columns stay at least 1 wide, else packed. */
export function columnLayout(room: number, count: number): { width: number; gap: number } {
  let gap = 1;
  let width = Math.floor((room + gap) / count) - gap;
  if (width < 1) {
    gap = 0;
    width = Math.max(1, Math.floor(room / count));
  }
  return { width: Math.min(MAX_COLUMN_WIDTH, width), gap };
}

/** Labels under the axis: first and last always, the ones between wherever they fit without touching. */
function drawAxisLabels(view: ScreenBuffer, y: number, x0: number, stride: number, used: number, labels: readonly string[], theme: TuiTheme): void {
  const style = { fg: theme.muted };
  const first = labels[0]!;
  view.text(x0, y, first, style, used);
  let end = x0 + [...first].length;
  const lastLabel = labels[labels.length - 1]!;
  // At its own column when the label fits there, else flush with the right edge.
  const lastX = Math.min(x0 + (labels.length - 1) * stride, x0 + used - [...lastLabel].length);
  const hasLast = labels.length > 1 && lastX >= end + LABEL_SPACING;
  const limit = hasLast ? lastX - LABEL_SPACING : x0 + used;
  for (let i = 1; i < labels.length - 1; i++) {
    const x = x0 + i * stride;
    const label = labels[i]!;
    if (x < end + LABEL_SPACING || x + [...label].length > limit) continue;
    view.text(x, y, label, style);
    end = x + [...label].length;
  }
  if (hasLast) view.text(lastX, y, lastLabel, style);
}

/** A titled box of stacked columns with a legend and peak on top and axis labels below; centred in the box, newest columns win when they do not all fit. */
export function drawColumnChart(view: ScreenBuffer, rect: Rect, theme: TuiTheme, options: ChartOptions): void {
  // The box title names how many columns survive, so the fit is worked out before the box is drawn (inner width = rect - 4).
  const room = rect.width - 4;
  const total = options.columns.length;
  const { width, gap } = columnLayout(Math.max(1, room), Math.max(1, total));
  const stride = width + gap;
  const count = Math.min(total, Math.max(0, Math.floor((room + gap) / stride)));
  const inner = drawBox(view, rect, theme, count > 0 && count < total ? `${options.title} · last ${count}` : options.title);
  const height = inner.height - 2; // a legend row above, an axis row below
  if (room < 1 || height < 1 || count < 1) return;
  const x0 = inner.x + 1;
  const columns = options.columns.slice(total - count);
  const used = count * stride - gap;
  const cx = x0 + Math.floor((room - used) / 2);

  const peak = Math.max(0, ...columns.map((c) => c.segments.reduce((sum, s) => sum + (s.value > 0 ? s.value : 0), 0)));
  const peakText = peak > 0 ? `max ${formatTokens(peak)}` : '';
  let x = x0;
  const visible = new Set(columns.flatMap((c) => c.segments.map((seg) => seg.key)));
  for (const item of (options.legend ?? []).filter((l) => visible.has(l.key))) {
    if (x + 2 + [...item.text].length > x0 + room - (peakText ? peakText.length + 2 : 0)) break;
    view.set(x, inner.y, '■', { fg: item.color });
    x += 2 + view.text(x + 2, inner.y, item.text, { fg: theme.muted }) + 2;
  }
  if (peakText) view.text(x0 + room - peakText.length, inner.y, peakText, { fg: theme.muted });

  drawStackedColumns(view, { x: cx, y: inner.y + 1, width: used, height }, columns, {
    width,
    gap,
    emptyColor: theme.faint,
    highlightColor: theme.ink,
  });
  drawAxisLabels(view, inner.y + inner.height - 1, cx, stride, used, columns.map((c) => c.label), theme);
}
