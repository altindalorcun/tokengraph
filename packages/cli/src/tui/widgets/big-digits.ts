import type { ScreenBuffer } from '../screen.js';

// Seven-segment style digits in heavy box drawing: 3 columns × 3 rows each.
const DIGITS: Record<string, readonly string[]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', '╺━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
};
// Separators are one column wide; only their bottom row is inked.
const SEPARATORS: Record<string, string> = { '.': '•', ',': ',' };

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch in DIGITS;
const isSeparator = (ch: string | undefined): boolean => ch !== undefined && ch in SEPARATORS;
const isBig = (ch: string | undefined): boolean => isDigit(ch) || isSeparator(ch);

/** Columns `text` takes: 3 + 1 gap per digit, 1 + 1 per '.' or ',', 1 per other char (no gap). */
export function bigTextWidth(text: string): number {
  const chars = [...text];
  let width = 0;
  chars.forEach((ch, i) => {
    width += isDigit(ch) ? 3 : 1;
    if (isBig(ch) && isBig(chars[i + 1])) width += 1;
  });
  return width;
}

/** Big digits in `color`; other characters as bold normal text in `unitColor ?? color` on the bottom row. */
export function drawBigText(buf: ScreenBuffer, x: number, y: number, text: string, color: string, unitColor?: string): void {
  const chars = [...text];
  let cx = x;
  chars.forEach((ch, i) => {
    const glyph = DIGITS[ch];
    if (glyph) {
      glyph.forEach((row, r) => buf.text(cx, y + r, row, { fg: color }));
      cx += 3;
    } else if (isSeparator(ch)) {
      buf.set(cx, y + 2, SEPARATORS[ch]!, { fg: color });
      cx += 1;
    } else {
      buf.set(cx, y + 2, ch, { fg: unitColor ?? color, bold: true });
      cx += 1;
    }
    if (isBig(ch) && isBig(chars[i + 1])) cx += 1;
  });
}
