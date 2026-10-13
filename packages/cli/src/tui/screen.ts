import { sgrBg, sgrFg, type ColorDepth } from './color.js';

export interface Style {
  fg?: string | null;
  bg?: string | null;
  bold?: boolean;
  dim?: boolean;
}
export interface Cell {
  ch: string;
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ESC = '\x1b[';
const BOLD = 1;
const DIM = 2;

/** NaN (e.g. an undefined `stdout.columns`), negative and infinite sizes become 0; fractions are floored. */
function sanitizeSize(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function floorRect(rect: Rect): Rect {
  return {
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.floor(rect.width),
    height: Math.floor(rect.height),
  };
}

/**
 * A grid of styled single-column cells. Stored as parallel arrays rather than a
 * Cell object per position so a 200×60 frame can be diffed at 60 fps without allocating.
 */
export class ScreenBuffer {
  readonly width: number;
  readonly height: number;
  private chs: string[];
  private fgs: (string | null)[];
  private bgs: (string | null)[];
  private flags: Uint8Array;

  constructor(width: number, height: number, fill: Style = {}) {
    this.width = sanitizeSize(width);
    this.height = sanitizeSize(height);
    const size = this.width * this.height;
    this.chs = new Array<string>(size).fill(' ');
    this.fgs = new Array<string | null>(size).fill(fill.fg ?? null);
    this.bgs = new Array<string | null>(size).fill(fill.bg ?? null);
    this.flags = new Uint8Array(size).fill((fill.bold ? BOLD : 0) | (fill.dim ? DIM : 0));
  }

  get(x: number, y: number): Cell | undefined {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!this.inRange(x, y)) return undefined;
    const i = y * this.width + x;
    const f = this.flags[i]!;
    return { ch: this.chs[i]!, fg: this.fgs[i]!, bg: this.bgs[i]!, bold: (f & BOLD) !== 0, dim: (f & DIM) !== 0 };
  }

  /** Out-of-range writes are ignored. Omitted style fields keep the cell's current value. */
  set(x: number, y: number, ch: string, style: Style = {}): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!this.inRange(x, y)) return;
    this.put(y * this.width + x, ch, style);
  }

  /** Writes `text` left to right, clipped to the buffer and to `maxWidth`; returns columns written. */
  text(x: number, y: number, text: string, style: Style = {}, maxWidth = Infinity): number {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!Number.isFinite(x) || !(y >= 0 && y < this.height)) return 0;
    let written = 0;
    let col = 0;
    for (const ch of text) {
      if (col >= maxWidth) break;
      const cx = x + col;
      col++;
      if (cx < 0) continue;
      if (cx >= this.width) break;
      this.put(y * this.width + cx, ch, style);
      written++;
    }
    return written;
  }

  fill(rect: Rect, ch: string, style: Style = {}): void {
    const r = floorRect(rect);
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(this.width, r.x + r.width);
    const y1 = Math.min(this.height, r.y + r.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) this.put(y * this.width + x, ch, style);
    }
  }

  clone(): ScreenBuffer {
    const copy = new ScreenBuffer(this.width, this.height);
    copy.chs = this.chs.slice();
    copy.fgs = this.fgs.slice();
    copy.bgs = this.bgs.slice();
    copy.flags = this.flags.slice();
    return copy;
  }

  /** Compares cell `i` of two same-sized buffers (used by `diff`). */
  cellsEqual(other: ScreenBuffer, i: number): boolean {
    return (
      this.chs[i] === other.chs[i] &&
      this.fgs[i] === other.fgs[i] &&
      this.bgs[i] === other.bgs[i] &&
      this.flags[i] === other.flags[i]
    );
  }

  /** The full SGR escape (reset plus attributes and colours) for cell `i`. */
  sgrAt(i: number, depth: ColorDepth): string {
    const f = this.flags[i]!;
    let out = `${ESC}0`;
    if (f & BOLD) out += ';1';
    if (f & DIM) out += ';2';
    const fg = sgrFg(this.fgs[i]!, depth);
    if (fg) out += `;${fg}`;
    const bg = sgrBg(this.bgs[i]!, depth);
    if (bg) out += `;${bg}`;
    return `${out}m`;
  }

  fgAt(i: number): string | null {
    return this.fgs[i]!;
  }

  bgAt(i: number): string | null {
    return this.bgs[i]!;
  }

  flagsAt(i: number): number {
    return this.flags[i]!;
  }

  charAt(i: number): string {
    return this.chs[i]!;
  }

  private inRange(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private put(i: number, ch: string, style: Style): void {
    this.chs[i] = ch === '' ? ' ' : String.fromCodePoint(ch.codePointAt(0)!);
    if (style.fg !== undefined) this.fgs[i] = style.fg;
    if (style.bg !== undefined) this.bgs[i] = style.bg;
    let f = this.flags[i]!;
    if (style.bold !== undefined) f = style.bold ? f | BOLD : f & ~BOLD;
    if (style.dim !== undefined) f = style.dim ? f | DIM : f & ~DIM;
    this.flags[i] = f;
  }
}

/** Minimal ANSI to turn `prev` into `next`; a null or differently sized `prev` repaints everything. */
export function diff(prev: ScreenBuffer | null, next: ScreenBuffer, depth: ColorDepth): string {
  const full = prev === null || prev.width !== next.width || prev.height !== next.height;
  const { width, height } = next;
  const out: string[] = [];
  let curX = -1;
  let curY = -1;
  let lastSgr = '';
  // Style of the last cell whose SGR was considered; the escape is rebuilt only when it changes.
  let lastFg: string | null | undefined;
  let lastBg: string | null | undefined;
  let lastFlags = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (prev !== null && !full && next.cellsEqual(prev, i)) continue;
      if (curX !== x || curY !== y) out.push(`${ESC}${y + 1};${x + 1}H`);
      const fg = next.fgAt(i);
      const bg = next.bgAt(i);
      const flags = next.flagsAt(i);
      if (fg !== lastFg || bg !== lastBg || flags !== lastFlags) {
        lastFg = fg;
        lastBg = bg;
        lastFlags = flags;
        const sgr = next.sgrAt(i, depth);
        if (sgr !== lastSgr) {
          out.push(sgr);
          lastSgr = sgr;
        }
      }
      out.push(next.charAt(i));
      curX = x + 1;
      curY = y;
    }
  }
  return out.join('');
}

/** Rows joined with '\n', trailing spaces trimmed — for tests. */
export function toPlainText(buffer: ScreenBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < buffer.height; y++) {
    let row = '';
    for (let x = 0; x < buffer.width; x++) row += buffer.charAt(y * buffer.width + x);
    rows.push(row.replace(/ +$/, ''));
  }
  return rows.join('\n');
}

/** One string per row with SGR colours, each ending in a reset — for `view --print`. */
export function toAnsiLines(buffer: ScreenBuffer, depth: ColorDepth): string[] {
  const lines: string[] = [];
  for (let y = 0; y < buffer.height; y++) {
    let line = '';
    let lastSgr = '';
    for (let x = 0; x < buffer.width; x++) {
      const i = y * buffer.width + x;
      if (depth !== 'none') {
        const sgr = buffer.sgrAt(i, depth);
        if (sgr !== lastSgr) {
          line += sgr;
          lastSgr = sgr;
        }
      }
      line += buffer.charAt(i);
    }
    lines.push(lastSgr ? `${line}${ESC}0m` : line);
  }
  return lines;
}

/** Shrinks a rect by `n` on every side (never below zero size). */
export function inset(rect: Rect, n: number): Rect {
  const r = floorRect(rect);
  const d = Math.floor(n);
  return { x: r.x + d, y: r.y + d, width: Math.max(0, r.width - 2 * d), height: Math.max(0, r.height - 2 * d) };
}
