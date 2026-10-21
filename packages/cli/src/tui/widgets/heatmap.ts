import { FAMILY_LABELS, cellColor, gridFamilies, legendRamp, type ColorMode, type GraphGrid, type Level } from '@tokengraph/core';
import type { Motion } from '../animate.js';
import { mix } from '../color.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import { familyColor, type TuiTheme } from '../theme.js';

export interface HeatmapProps {
  grid: GraphGrid;
  theme: TuiTheme;
  colorMode: ColorMode;
  /** Selected date, drawn as a highlighted cell; null for none. */
  cursor: string | null;
  today: string;
  motion: Motion;
}
export interface HeatmapLayout {
  /** Columns of `grid.columns` actually drawn (the most recent ones that fit). */
  firstColumn: number;
  /** Screen x of week column `firstColumn`, and screen y of weekday row 0 (Sunday). */
  originX: number;
  originY: number;
  /** Columns per week: 2 for compact cells, 3 for large ones. */
  step: 2 | 3;
  /** Total width and height used, including labels and legend. */
  width: number;
  height: number;
}

const LABEL_WIDTH = 4;
const WEEKS = 52;
/** Width the full 52-week heatmap needs: 4 label columns + 2 per week. */
export const HEATMAP_FULL_WIDTH = LABEL_WIDTH + 2 * WEEKS;
/** Width that shows all 52 weeks in large cells: 4 label columns + 3 per week. */
export const HEATMAP_LARGE_WIDTH = LABEL_WIDTH + 3 * WEEKS;
/** Narrowest width that still uses large cells; fewer than 52 weeks are shown (the most recent ones). */
export const HEATMAP_LARGE_MIN_WIDTH = LABEL_WIDTH + 3 * 40;
/** Month row, 7 day rows, blank, legend. */
export const HEATMAP_HEIGHT = 10;

const WEEKDAY_LABELS: readonly (readonly [number, string])[] = [
  [1, 'Mon'],
  [3, 'Wed'],
  [5, 'Fri'],
];
const LEVELS: readonly Level[] = [0, 1, 2, 3, 4, 5];

/** Draws the year grid into `rect` (most recent weeks first if it is too narrow) and returns where the cells landed. */
export function drawHeatmap(buf: ScreenBuffer, rect: Rect, props: HeatmapProps): HeatmapLayout {
  const { grid, theme, colorMode, cursor, today, motion } = props;
  const step = rect.width >= HEATMAP_LARGE_MIN_WIDTH ? 3 : 2;
  const weeks = Math.max(0, Math.min(grid.columns.length, Math.floor((rect.width - LABEL_WIDTH) / step)));
  const firstColumn = grid.columns.length - weeks;
  const originX = rect.x + LABEL_WIDTH;
  const originY = rect.y + 1;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const layout: HeatmapLayout = {
    firstColumn,
    originX,
    originY,
    step,
    width: LABEL_WIDTH + step * weeks,
    height: Math.min(HEATMAP_HEIGHT, Math.max(0, rect.height)),
  };

  // Clipped to the rect on every side: callers pack other widgets right next to it.
  const write = (x: number, y: number, text: string, style: { fg?: string | null; bg?: string | null; bold?: boolean }) => {
    if (y < rect.y || y >= bottom || x >= right) return;
    buf.text(x, y, text, style, right - x);
  };

  let lastEnd = originX - 2; // last column a label occupied; the next one needs a space gap after it
  for (const month of grid.months) {
    const x = originX + (month.column - firstColumn) * step;
    // A label that does not fit whole is skipped, never cut ("Oc").
    if (x < originX || x < lastEnd + 2 || x + month.label.length > right) continue;
    write(x, rect.y, month.label, { fg: theme.muted });
    lastEnd = x + month.label.length - 1;
  }

  for (const [weekday, label] of WEEKDAY_LABELS) write(rect.x, originY + weekday, label, { fg: theme.faint });

  const flash = theme.name === 'light' ? '#000000' : '#ffffff';
  for (let k = 0; k < weeks; k++) {
    const column = grid.columns[firstColumn + k]!;
    for (let weekday = 0; weekday < 7; weekday++) {
      const cell = column[weekday];
      if (!cell) continue;
      const x = originX + step * k;
      const y = originY + weekday;
      if (y >= bottom) continue;
      const target = cellColor(cell.level, { colorMode, theme: theme.name, family: cell.topFamily, empty: theme.empty });
      let fg = mix(theme.empty, target, motion.cell(k, weekday));
      if (cell.date === today && motion.pulse > 0) fg = mix(fg, flash, 0.6 * motion.pulse);
      if (cell.date === cursor && step === 3) {
        write(x, y, '██', { fg: cell.level === 0 ? theme.muted : mix(target, flash, 0.35), bg: theme.bg });
      } else if (cell.date === cursor) {
        write(x - 1, y, '▐', { fg: theme.ink, bg: theme.bg });
        write(x, y, '█', { fg: cell.level === 0 ? theme.muted : fg, bg: theme.bg });
        write(x + 1, y, '▌', { fg: theme.ink, bg: theme.bg });
      } else if (step === 3) {
        // Seven-eighths blocks: with 1:2 terminal cells, 2 wide × 1.75 tall reads as a square.
        write(x, y, '▇▇', { fg, bg: theme.bg });
      } else {
        write(x, y, '▀', { fg, bg: theme.bg });
      }
    }
  }

  // Legend: the intensity scale (red in single mode, hueless grey when each day carries a family hue), then (per-model only) one swatch per family on screen.
  const legendY = rect.y + HEATMAP_HEIGHT - 1;
  let x = rect.x;
  write(x, legendY, 'Less', { fg: theme.muted });
  x += 5;
  const swatch = step === 3 ? '▇▇' : '▀';
  for (const level of LEVELS) {
    write(x, legendY, swatch, { fg: level === 0 ? theme.empty : legendRamp(theme.name, colorMode)[level]!, bg: theme.bg });
    x += step;
  }
  write(x, legendY, 'More', { fg: theme.muted });
  x += 4;
  if (colorMode === 'per-model') {
    const families = gridFamilies(grid);
    for (const [i, family] of families.entries()) {
      const label = FAMILY_LABELS[family];
      const rest = families.length - i;
      const more = (n: number) => `+${n} more`;
      // Whatever does not fit whole collapses into "+N more": a family is never cut mid-name.
      const fits = x + 2 + step + label.length + (rest > 1 ? 2 + more(rest - 1).length : 0) <= right;
      if (!fits) {
        if (x + 2 + more(rest).length <= right) write(x + 2, legendY, more(rest), { fg: theme.muted });
        break;
      }
      x += 2;
      write(x, legendY, swatch, { fg: familyColor(family, theme), bg: theme.bg });
      write(x + step, legendY, label, { fg: theme.muted });
      x += step + label.length;
    }
  }
  return layout;
}

/** Which date is under screen (x, y), or null. Only a week's cell columns count (1 compact, 2 large), not the gap after them. */
export function hitTest(layout: HeatmapLayout, grid: GraphGrid, x: number, y: number): string | null {
  const dx = x - layout.originX;
  const weekday = y - layout.originY;
  const cellColumns = layout.step === 3 ? 2 : 1;
  if (dx < 0 || dx % layout.step >= cellColumns || dx >= layout.width - LABEL_WIDTH) return null;
  if (weekday < 0 || weekday > 6) return null;
  const column = grid.columns[layout.firstColumn + Math.floor(dx / layout.step)];
  return column?.[weekday]?.date ?? null;
}
