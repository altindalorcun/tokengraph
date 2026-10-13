export type Rgb = readonly [number, number, number];
export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

/** xterm's default 16 colours, index → rgb. */
const PALETTE_16: readonly Rgb[] = [
  [0x00, 0x00, 0x00],
  [0xcd, 0x00, 0x00],
  [0x00, 0xcd, 0x00],
  [0xcd, 0xcd, 0x00],
  [0x00, 0x00, 0xee],
  [0xcd, 0x00, 0xcd],
  [0x00, 0xcd, 0xcd],
  [0xe5, 0xe5, 0xe5],
  [0x7f, 0x7f, 0x7f],
  [0xff, 0x00, 0x00],
  [0x00, 0xff, 0x00],
  [0xff, 0xff, 0x00],
  [0x5c, 0x5c, 0xff],
  [0xff, 0x00, 0xff],
  [0x00, 0xff, 0xff],
  [0xff, 0xff, 0xff],
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parses '#rrggbb' or '#rgb'; throws on anything else. */
export function hexToRgb(hex: string): Rgb {
  if (!HEX_RE.test(hex)) throw new Error(`Invalid hex colour: ${hex}`);
  const digits = hex.slice(1);
  const full = digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function channelHex(value: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(value)));
  return clamped.toString(16).padStart(2, '0');
}

/** Lower-case '#rrggbb'; channels are rounded and clamped to 0..255. */
export function rgbToHex(rgb: Rgb): string {
  return `#${channelHex(rgb[0])}${channelHex(rgb[1])}${channelHex(rgb[2])}`;
}

/** Linear RGB interpolation from `a` to `b`; `t` is clamped to 0..1. */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k]);
}

function distance(a: Rgb, b: Rgb): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function nearestCubeLevel(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_LEVELS.length; i++) {
    if (Math.abs(CUBE_LEVELS[i]! - value) < Math.abs(CUBE_LEVELS[best]! - value)) best = i;
  }
  return best;
}

/** Closest xterm-256 index (6×6×6 cube or 24-step grey ramp, 16..255); ties go to the cube. */
export function nearest256(rgb: Rgb): number {
  const r = nearestCubeLevel(rgb[0]);
  const g = nearestCubeLevel(rgb[1]);
  const b = nearestCubeLevel(rgb[2]);
  const cubeDist = distance(rgb, [CUBE_LEVELS[r]!, CUBE_LEVELS[g]!, CUBE_LEVELS[b]!]);

  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const k = Math.min(23, Math.max(0, Math.round((mean - 8) / 10)));
  const grey = 8 + 10 * k;
  const greyDist = distance(rgb, [grey, grey, grey]);

  return greyDist < cubeDist ? 232 + k : 16 + 36 * r + 6 * g + b;
}

/** Closest of the xterm default 16 colours (0..15). */
export function nearest16(rgb: Rgb): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE_16.length; i++) {
    const d = distance(rgb, PALETTE_16[i]!);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

const SGR_CACHE_LIMIT = 4096;
const sgrCache = new Map<string, string>();

function sgrColor(hex: string | null, depth: ColorDepth, base: 30 | 40): string {
  if (depth === 'none') return '';
  if (hex === null) return String(base + 9);
  // Memoised: diff asks for the same few colours on every changed cell, and parsing plus
  // nearest-colour search per cell is the hot cost at 60 fps.
  const key = `${base}${depth}${hex}`;
  const cached = sgrCache.get(key);
  if (cached !== undefined) return cached;
  const rgb = hexToRgb(hex);
  let result: string;
  if (depth === 'truecolor') result = `${base + 8};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  else if (depth === '256') result = `${base + 8};5;${nearest256(rgb)}`;
  else {
    const i = nearest16(rgb);
    result = String(i < 8 ? base + i : base + 60 + i - 8);
  }
  if (sgrCache.size >= SGR_CACHE_LIMIT) sgrCache.clear();
  sgrCache.set(key, result);
  return result;
}

/** SGR parameters (no ESC[ or m) for a foreground colour; null resets it, depth none gives ''. */
export function sgrFg(hex: string | null, depth: ColorDepth): string {
  return sgrColor(hex, depth, 30);
}

/** SGR parameters (no ESC[ or m) for a background colour; null resets it, depth none gives ''. */
export function sgrBg(hex: string | null, depth: ColorDepth): string {
  return sgrColor(hex, depth, 40);
}
