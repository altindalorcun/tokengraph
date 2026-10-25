import type { ColorMode, GraphGrid } from '@tokengraph/core';
import type { ActionId } from '../actions.js';
import type { Motion } from '../animate.js';
import type { RangeKey, ViewModel } from '../model.js';
import type { ScreenBuffer, Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import type { HeatmapLayout } from '../widgets/heatmap.js';

export interface ViewProps {
  vm: ViewModel;
  theme: TuiTheme;
  motion: Motion;
  colorMode: ColorMode;
}
export interface OverviewState {
  cursor: string;
  yearEnd: string;
}
export interface TableState {
  range: RangeKey;
  selected: number;
}
/** Clickable regions a view reports back to the app. */
export type Hit =
  | { kind: 'day'; date: string; rect: Rect }
  | { kind: 'range'; range: RangeKey; rect: Rect }
  | { kind: 'row'; index: number; rect: Rect }
  | { kind: 'action'; id: ActionId; rect: Rect }
  | { kind: 'hour'; hour: number; rect: Rect };
export interface ViewResult {
  hits: Hit[];
  /** Heatmap layout for hover hit-testing, when drawn. */
  heatmap?: { layout: HeatmapLayout; grid: GraphGrid };
}

/**
 * Copies `source` onto `target` at (x, y). Default cells (a space with no fg and no bg) are skipped so
 * whatever the app painted underneath shows through. A null fg/bg keeps the target's colour (put only keeps it for undefined); anything outside `target` is dropped by `set`.
 */
export function blit(target: ScreenBuffer, source: ScreenBuffer, x: number, y: number): void {
  for (let sy = 0; sy < source.height; sy++) {
    for (let sx = 0; sx < source.width; sx++) {
      const cell = source.get(sx, sy);
      if (!cell || (cell.ch === ' ' && cell.fg === null && cell.bg === null)) continue;
      target.set(x + sx, y + sy, cell.ch, { fg: cell.fg ?? undefined, bg: cell.bg ?? undefined, bold: cell.bold, dim: cell.dim });
    }
  }
}
