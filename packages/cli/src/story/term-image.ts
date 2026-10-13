export type ImageProtocol = 'iterm' | 'kitty' | 'none';

/** Terminals that draw real images inline. Inside tmux the escapes need passthrough, so no. */
export function detectImageProtocol(env: NodeJS.ProcessEnv): ImageProtocol {
  if (env['TMUX']) return 'none';
  const program = env['TERM_PROGRAM'];
  if (program === 'iTerm.app' || program === 'WezTerm') return 'iterm';
  if (env['KITTY_WINDOW_ID'] || env['TERM'] === 'xterm-kitty' || program === 'ghostty') return 'kitty';
  return 'none';
}

export function supportsTruecolor(env: NodeJS.ProcessEnv): boolean {
  return env['COLORTERM'] === 'truecolor' || env['COLORTERM'] === '24bit';
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export function itermImage(png: Uint8Array, widthCells: number): string {
  return `\x1b]1337;File=inline=1;size=${png.length};width=${widthCells};preserveAspectRatio=1:${base64(png)}\x07`;
}

const KITTY_CHUNK = 4096;

export function kittyImage(png: Uint8Array, widthCells: number): string {
  const data = base64(png);
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += KITTY_CHUNK) {
    const chunk = data.slice(i, i + KITTY_CHUNK);
    const more = i + KITTY_CHUNK < data.length ? 1 : 0;
    parts.push(i === 0 ? `\x1b_Gf=100,a=T,c=${widthCells},m=${more};${chunk}\x1b\\` : `\x1b_Gm=${more};${chunk}\x1b\\`);
  }
  return parts.join('');
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/**
 * Nearest xterm 256-colour index for an RGB colour: the 6x6x6 cube (16..231) or the grey ramp (232..255),
 * whichever is closer. The ramp matters for dark cards, which the cube alone would flatten to black.
 */
export function rgbTo256(r: number, g: number, b: number): number {
  const nearestLevel = (v: number) => {
    let best = 0;
    for (let i = 1; i < CUBE_LEVELS.length; i += 1) if (Math.abs(CUBE_LEVELS[i]! - v) < Math.abs(CUBE_LEVELS[best]! - v)) best = i;
    return best;
  };
  const distance = (cr: number, cg: number, cb: number) => (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
  const [ri, gi, bi] = [nearestLevel(r), nearestLevel(g), nearestLevel(b)] as const;
  let best = 16 + 36 * ri + 6 * gi + bi;
  let bestDistance = distance(CUBE_LEVELS[ri]!, CUBE_LEVELS[gi]!, CUBE_LEVELS[bi]!);
  for (let i = 0; i < 24; i += 1) {
    const level = 8 + 10 * i;
    const d = distance(level, level, level);
    if (d < bestDistance) {
      best = 232 + i;
      bestDistance = d;
    }
  }
  return best;
}

type Rgb = [number, number, number];

function pixel(rgba: Uint8Array, width: number, height: number, x: number, y: number, background: Rgb): Rgb {
  if (y >= height) return background;
  const i = (y * width + x) * 4;
  const alpha = rgba[i + 3]! / 255;
  return [0, 1, 2].map((c) => Math.round(rgba[i + c]! * alpha + background[c]! * (1 - alpha))) as Rgb;
}

/** Two vertical pixels per character cell: the top one as foreground of ▀, the bottom one as background. */
export function halfBlockImage(rgba: Uint8Array, width: number, height: number, options: { truecolor: boolean; background?: Rgb }): string[] {
  const background = options.background ?? [0, 0, 0];
  const fg = ([r, g, b]: Rgb) => (options.truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`);
  const bg = ([r, g, b]: Rgb) => (options.truecolor ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${rgbTo256(r, g, b)}m`);
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = '';
    for (let x = 0; x < width; x += 1) {
      line += `${fg(pixel(rgba, width, height, x, y, background))}${bg(pixel(rgba, width, height, x, y + 1, background))}▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}
