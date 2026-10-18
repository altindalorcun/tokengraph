import { describe, expect, it } from 'vitest';
import { detectImageProtocol, itermImage, kittyImage } from '../src/story/term-image.js';

describe('detectImageProtocol', () => {
  it('knows the terminals that draw images', () => {
    expect(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm');
    expect(detectImageProtocol({ TERM_PROGRAM: 'WezTerm' })).toBe('iterm');
    expect(detectImageProtocol({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectImageProtocol({ TERM: 'xterm-kitty' })).toBe('kitty');
    expect(detectImageProtocol({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
    expect(detectImageProtocol({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('none');
    expect(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux' })).toBe('none');
    expect(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app', STY: '1234.pts-0.host' })).toBe('none');
    expect(detectImageProtocol({ TERM_PROGRAM: 'WezTerm', TERM: 'screen-256color' })).toBe('none');
    expect(detectImageProtocol({ KITTY_WINDOW_ID: '1', TERM: 'screen' })).toBe('none');
  });

});

describe('encoders', () => {
  const png = new Uint8Array(5000).fill(7);

  it('wraps an iTerm2 inline image', () => {
    const out = itermImage(png, 60);
    expect(out.startsWith('\x1b]1337;File=inline=1;size=5000;width=60;preserveAspectRatio=1:')).toBe(true);
    expect(out.endsWith('\x07')).toBe(true);
  });

  it('chunks a Kitty image at 4096 base64 characters', () => {
    const out = kittyImage(png, 60);
    const chunks = out.split('\x1b\\').filter(Boolean);
    expect(chunks[0]!.startsWith('\x1b_Gf=100,a=T,q=2,c=60,m=1;')).toBe(true);
    expect(chunks.at(-1)!.startsWith('\x1b_Gq=2,m=0;')).toBe(true);
    for (const chunk of chunks) expect(chunk.split(';')[1]!.length).toBeLessThanOrEqual(4096);
  });
});
