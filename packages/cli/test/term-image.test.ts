import { describe, expect, it } from 'vitest';
import { detectImageProtocol, halfBlockImage, itermImage, kittyImage, rgbTo256, supportsTruecolor } from '../src/story/term-image.js';

describe('detectImageProtocol', () => {
  it('knows the terminals that draw images', () => {
    expect(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm');
    expect(detectImageProtocol({ TERM_PROGRAM: 'WezTerm' })).toBe('iterm');
    expect(detectImageProtocol({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectImageProtocol({ TERM: 'xterm-kitty' })).toBe('kitty');
    expect(detectImageProtocol({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
    expect(detectImageProtocol({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('none');
    expect(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux' })).toBe('none');
  });

  it('reads truecolor support from COLORTERM', () => {
    expect(supportsTruecolor({ COLORTERM: 'truecolor' })).toBe(true);
    expect(supportsTruecolor({ COLORTERM: '24bit' })).toBe(true);
    expect(supportsTruecolor({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
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

describe('halfBlockImage', () => {
  // 1 px wide, 2 px tall: red over blue.
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);

  it('draws two pixels per cell in truecolor', () => {
    expect(halfBlockImage(rgba, 1, 2, { truecolor: true })).toEqual(['\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀\x1b[0m']);
  });

  it('falls back to the 256-colour cube', () => {
    expect(halfBlockImage(rgba, 1, 2, { truecolor: false })).toEqual([`\x1b[38;5;${rgbTo256(255, 0, 0)}m\x1b[48;5;${rgbTo256(0, 0, 255)}m▀\x1b[0m`]);
    expect(rgbTo256(255, 0, 0)).toBe(196);
    expect(rgbTo256(0, 0, 0)).toBe(16);
  });

  it('keeps dark colours apart from black with the grey ramp', () => {
    expect(rgbTo256(29, 29, 29)).toBeGreaterThanOrEqual(232);
    expect(rgbTo256(128, 128, 128)).toBeGreaterThanOrEqual(232);
    expect(rgbTo256(255, 255, 255)).toBe(231);
    expect(rgbTo256(0, 0, 255)).toBe(21);
  });

  it('blends transparency onto the background and pads an odd height', () => {
    const transparent = new Uint8Array([255, 255, 255, 0]);
    expect(halfBlockImage(transparent, 1, 1, { truecolor: true, background: [10, 20, 30] })).toEqual(['\x1b[38;2;10;20;30m\x1b[48;2;10;20;30m▀\x1b[0m']);
  });
});
