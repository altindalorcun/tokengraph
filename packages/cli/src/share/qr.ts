import qrcode from 'qrcode-generator';

/** Error correction M: survives a smudged screen and still fits a LAN URL in a small symbol. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

const INK = '\x1b[38;5;16m';
const PAPER = '\x1b[38;5;231m';
const INK_BG = '\x1b[48;5;16m';
const PAPER_BG = '\x1b[48;5;231m';
const RESET = '\x1b[0m';

/**
 * Two module rows per text line. Colours are forced (black on white) because a phone camera reads
 * dark-on-light; a dark terminal theme would otherwise invert the code.
 *
 * Terminals that draw block glyphs from the font (Apple Terminal) leave a strip under the glyph that
 * only the cell background fills. So a cell whose two modules match is a space painted with the
 * background, and a mixed cell is ▄ in the bottom module's colour over the top module's background:
 * the strip then takes the top module's colour, which a phone still reads. Glyph-only blocks left
 * white lines through the code that phones failed on.
 *
 * With `color: false` (no terminal) the same layout is printed as plain half blocks.
 */
export function qrLines(matrix: boolean[][], options: { quiet?: number; color?: boolean } = {}): string[] {
  const quiet = options.quiet ?? 2;
  const color = options.color ?? true;
  const size = matrix.length + quiet * 2;
  const dark = (row: number, col: number) => {
    const r = row - quiet;
    const c = col - quiet;
    return r >= 0 && c >= 0 && r < matrix.length && c < matrix.length && matrix[r]![c]!;
  };
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      if (!color) line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      else if (top === bottom) line += `${top ? INK_BG : PAPER_BG} `;
      else line += `${bottom ? INK : PAPER}${top ? INK_BG : PAPER_BG}▄`;
    }
    lines.push(color ? `${line}${RESET}` : line);
  }
  return lines;
}
