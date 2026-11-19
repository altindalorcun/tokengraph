/**
 * Terminal column widths for the task box. The screen buffer holds one character per column, so a character a
 * terminal draws two columns wide (CJK, fullwidth forms, emoji) would push the rest of its row, and the box's right
 * border, one column out of line. Text from a command is therefore narrowed before it is drawn.
 */

// East Asian Wide and Fullwidth blocks (Unicode EastAsianWidth W/F), the common ones.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1b000, 0x1b2ff], [0x1f200, 0x1f2ff], [0x20000, 0x3fffd],
];
const EMOJI = /\p{Emoji_Presentation}/u;
// Combining marks, format characters (zero-width joiner, variation selectors' neighbours) and other zero-width code points.
const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;

/** Columns a terminal gives one code point: 0, 1 or 2. */
export function charWidth(char: string): 0 | 1 | 2 {
  if (ZERO.test(char)) return 0;
  const code = char.codePointAt(0) ?? 0;
  if (EMOJI.test(char)) return 2;
  for (const [lo, hi] of WIDE_RANGES) if (code >= lo && code <= hi) return 2;
  return 1;
}

/** Columns `text` takes on a terminal. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

/** What the box draws for one code point: itself, nothing (zero width), or a one-column stand-in (two columns wide). */
export function narrowChar(char: string): string {
  const width = charWidth(char);
  if (width === 0) return '';
  if (width === 1) return char;
  return char === '⭐' ? '★' : EMOJI.test(char) ? '*' : '?';
}

/** `text` with every character one column wide, so its length in code points is its width on screen. */
export function narrow(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) out += narrowChar(char);
  return out;
}
