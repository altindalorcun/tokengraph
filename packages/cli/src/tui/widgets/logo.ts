import type { ScreenBuffer } from '../screen.js';
import { FLAME_PALETTE, type TuiTheme } from '../theme.js';

/** The product mark as an 8×11 grid; digits index FLAME_PALETTE (0 hottest), '.' is empty. */
export const FLAME: readonly string[] = [
  '..66....',
  '..555...',
  '..5555..',
  '.544445.',
  '54444445',
  '54333345',
  '43333334',
  '43222234',
  '43211234',
  '.200002.',
  '...00...',
];

const FLAME_WIDTH = 8;

/**
 * Paints a grid of optional colours (two grid rows per terminal row) as half blocks: the top cell is the
 * foreground of ▀, the bottom cell its background; a lone bottom cell is a ▄ on `background`.
 */
function paintHalfBlocks(
  buf: ScreenBuffer,
  x: number,
  y: number,
  width: number,
  rows: number,
  at: (col: number, row: number) => string | null,
  background: string,
): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < width; c++) {
      const top = at(c, 2 * r);
      const bottom = at(c, 2 * r + 1);
      if (top && bottom) buf.set(x + c, y + r, '▀', { fg: top, bg: bottom });
      else if (top) buf.set(x + c, y + r, '▀', { fg: top, bg: background });
      else if (bottom) buf.set(x + c, y + r, '▄', { fg: bottom, bg: background });
      else buf.set(x + c, y + r, ' ', { bg: background });
    }
  }
}

/** The flame drawn with half blocks (two cell rows per terminal row): 8 columns × 6 rows. `progress` 0..1 reveals cells from the base up (row 10 first). */
export function drawFlame(buf: ScreenBuffer, x: number, y: number, background: string, progress = 1): void {
  const cells: { row: number; col: number }[] = [];
  FLAME.forEach((line, row) => {
    for (let col = 0; col < FLAME_WIDTH; col++) if (line[col] !== '.') cells.push({ row, col });
  });
  cells.sort((a, b) => b.row - a.row || a.col - b.col);
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 1;
  const visible = new Set(cells.slice(0, Math.round(p * cells.length)).map((cell) => cell.row * FLAME_WIDTH + cell.col));
  paintHalfBlocks(
    buf,
    x,
    y,
    FLAME_WIDTH,
    6,
    (col, row) => {
      const ch = FLAME[row]?.[col];
      if (ch === undefined || ch === '.' || !visible.has(row * FLAME_WIDTH + col)) return null;
      return FLAME_PALETTE[Number(ch)]!;
    },
    background,
  );
}

// Hand-drawn 4×4-pixel flame for the header (2 terminal rows); a downscale of FLAME read as a red block.
const MINI_FLAME: readonly string[] = ['.6..', '.55.', '5445', '4224'];
const MINI_COLS = 4;

function miniPixel(col: number, row: number): string | null {
  const ch = MINI_FLAME[row]?.[col];
  return ch === undefined || ch === '.' ? null : FLAME_PALETTE[Number(ch)]!;
}

/** A 2-row, 4-column miniature of the flame for the header, plus "tokengraph" in ink bold at x+5. */
export function drawHeaderMark(buf: ScreenBuffer, x: number, y: number, theme: TuiTheme): void {
  paintHalfBlocks(buf, x, y, MINI_COLS, 2, miniPixel, theme.bg);
  buf.text(x + 5, y, 'tokengraph', { fg: theme.ink, bold: true });
}
