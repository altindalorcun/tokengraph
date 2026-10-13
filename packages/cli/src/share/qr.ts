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
const PAPER = '\x1b[48;5;231m';
const RESET = '\x1b[0m';

/**
 * Two module rows per text line. Colours are forced (black ink on white paper) because a phone
 * camera reads dark-on-light; a dark terminal theme would otherwise invert the code.
 */
export function qrLines(matrix: boolean[][], quiet = 4): string[] {
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
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`${INK}${PAPER}${line}${RESET}`);
  }
  return lines;
}
