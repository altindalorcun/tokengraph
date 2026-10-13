import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from './box.js';

export interface Tile {
  title: string;
  value: string;
  detail?: string;
  /** Shorter form tried when `detail` does not fit whole. */
  shortDetail?: string;
  detailColor?: string;
}

const MIN_TILE_WIDTH = 14;

/** A row of equal-width boxed tiles: value in ink bold, detail after it (whole or omitted). Tiles narrower than 14 columns are dropped from the right. */
export function drawTiles(buf: ScreenBuffer, rect: Rect, tiles: readonly Tile[], theme: TuiTheme): void {
  let count = tiles.length;
  while (count > 0 && Math.floor(rect.width / count) < MIN_TILE_WIDTH) count--;
  if (count === 0 || rect.height < 1) return;
  const base = Math.floor(rect.width / count);
  const extra = rect.width - base * count; // remainder columns go to the leftmost tiles
  let x = rect.x;
  for (let i = 0; i < count; i++) {
    const tile = tiles[i]!;
    const width = base + (i < extra ? 1 : 0);
    const inner = drawBox(buf, { x, y: rect.y, width, height: rect.height }, theme, tile.title);
    if (inner.height > 0 && inner.width > 2) {
      const left = inner.x + 1; // one column of padding inside the border
      const room = inner.width - 2;
      const used = buf.text(left, inner.y, tile.value, { fg: theme.ink, bold: true }, room);
      // A detail is shown whole or not at all.
      const detail = [tile.detail, tile.shortDetail].find((d) => d !== undefined && [...d].length <= room - used - 2);
      if (detail) buf.text(left + used + 2, inner.y, detail, { fg: tile.detailColor ?? theme.muted, bold: false });
    }
    x += width;
  }
}
