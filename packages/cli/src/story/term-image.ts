export type ImageProtocol = 'iterm' | 'kitty' | 'none';

/** Terminals that draw real images inline. Inside tmux or GNU screen the escapes need passthrough, so no. */
export function detectImageProtocol(env: NodeJS.ProcessEnv): ImageProtocol {
  if (env['TMUX'] || env['STY'] || env['TERM']?.startsWith('screen')) return 'none';
  const program = env['TERM_PROGRAM'];
  if (program === 'iTerm.app' || program === 'WezTerm') return 'iterm';
  if (env['KITTY_WINDOW_ID'] || env['TERM'] === 'xterm-kitty' || program === 'ghostty') return 'kitty';
  return 'none';
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
    parts.push(i === 0 ? `\x1b_Gf=100,a=T,q=2,c=${widthCells},m=${more};${chunk}\x1b\\` : `\x1b_Gq=2,m=${more};${chunk}\x1b\\`);
  }
  return parts.join('');
}
