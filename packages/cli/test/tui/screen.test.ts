import { describe, expect, it } from 'vitest';
import { ScreenBuffer, diff, inset, toAnsiLines, toPlainText } from '../../src/tui/screen.js';

describe('ScreenBuffer', () => {
  it('writes, clips and keeps unspecified style fields', () => {
    const buf = new ScreenBuffer(6, 2, { bg: '#000000' });
    expect(buf.text(4, 0, 'hello', { fg: '#ffffff' })).toBe(2);
    buf.set(-1, 0, 'x');
    buf.set(0, 5, 'x');
    expect(toPlainText(buf)).toBe('    he\n');
    expect(buf.get(4, 0)).toEqual({ ch: 'h', fg: '#ffffff', bg: '#000000', bold: false, dim: false });
    expect(buf.text(0, 1, 'abcdef', {}, 3)).toBe(3);
    expect(toPlainText(buf)).toBe('    he\nabc');
  });

  it('fills rects and insets', () => {
    const buf = new ScreenBuffer(4, 3);
    buf.fill({ x: 1, y: 1, width: 10, height: 10 }, '#');
    expect(toPlainText(buf)).toBe('\n ###\n ###');
    expect(inset({ x: 0, y: 0, width: 10, height: 4 }, 1)).toEqual({ x: 1, y: 1, width: 8, height: 2 });
    expect(inset({ x: 0, y: 0, width: 1, height: 1 }, 2)).toEqual({ x: 2, y: 2, width: 0, height: 0 });
  });

  it('truncates multi-character input and turns empty into a space', () => {
    const buf = new ScreenBuffer(2, 1);
    buf.set(0, 0, 'ab');
    buf.set(1, 0, '');
    expect(buf.get(0, 0)?.ch).toBe('a');
    expect(buf.get(1, 0)?.ch).toBe(' ');
    expect(buf.get(2, 0)).toBeUndefined();
  });

  it('floors fractional coordinates onto the cell they fall in', () => {
    const buf = new ScreenBuffer(4, 2);
    buf.set(1.5, 0.9, 'x');
    expect(buf.get(1, 0)?.ch).toBe('x');
    expect(buf.get(1.7, 0.2)?.ch).toBe('x');
    expect(buf.text(2.5, 1.2, 'ab')).toBe(2);
    expect(toPlainText(buf)).toBe(' x\n  ab');
    expect(inset({ x: 0.5, y: 0.5, width: 10.5, height: 4.5 }, 1)).toEqual({ x: 1, y: 1, width: 8, height: 2 });
  });

  it('fills the floored rect for fractional rects', () => {
    const buf = new ScreenBuffer(5, 3);
    buf.fill({ x: 1.5, y: 0.5, width: 2.9, height: 1.9 }, '#');
    expect(toPlainText(buf)).toBe(' ##\n\n');
  });

  it('treats non-finite or negative sizes as empty', () => {
    for (const size of [NaN, Infinity, -3]) {
      const buf = new ScreenBuffer(size, 2);
      expect(buf.width).toBe(0);
      expect(() => toPlainText(buf)).not.toThrow();
      expect(buf.get(0, 0)).toBeUndefined();
    }
    expect(new ScreenBuffer(3.9, 2.2).width).toBe(3);
    expect(new ScreenBuffer(3.9, 2.2).height).toBe(2);
    const buf = new ScreenBuffer(2, 2);
    expect(buf.text(NaN, 0, 'ab')).toBe(0);
    expect(() => buf.set(NaN, NaN, 'x')).not.toThrow();
  });

  it('clones independently', () => {
    const buf = new ScreenBuffer(2, 1);
    const copy = buf.clone();
    copy.set(0, 0, 'z');
    expect(buf.get(0, 0)?.ch).toBe(' ');
    expect(copy.get(0, 0)?.ch).toBe('z');
  });
});

describe('diff', () => {
  it('repaints everything without a previous frame', () => {
    const next = new ScreenBuffer(2, 1);
    next.text(0, 0, 'ab');
    const out = diff(null, next, 'truecolor');
    expect(out).toContain('\x1b[1;1H');
    expect(out).toContain('ab');
  });

  it('repaints everything when the size changed', () => {
    const next = new ScreenBuffer(2, 2);
    const out = diff(new ScreenBuffer(3, 2), next, 'none');
    expect(out).toContain('\x1b[1;1H');
    expect(out).toContain('\x1b[2;1H');
  });

  it('writes only the changed cells', () => {
    const prev = new ScreenBuffer(5, 2);
    prev.text(0, 0, 'hello');
    const next = prev.clone();
    next.set(4, 1, 'Z', { fg: '#ff0000' });
    const out = diff(prev, next, 'truecolor');
    expect(out).toBe('\x1b[2;5H\x1b[0;38;2;255;0;0;49mZ');
  });

  it('emits a style-only change on the same character', () => {
    const prev = new ScreenBuffer(3, 1);
    prev.text(0, 0, 'abc');
    const next = prev.clone();
    next.set(1, 0, 'b', { fg: '#00ff00' });
    expect(diff(prev, next, 'truecolor')).toBe('\x1b[1;2H\x1b[0;38;2;0;255;0;49mb');
  });

  it('re-emits the SGR when the style changes between changed cells', () => {
    const prev = new ScreenBuffer(3, 1);
    const next = prev.clone();
    next.set(0, 0, 'a', { fg: '#ff0000' });
    next.set(1, 0, 'b', { fg: '#ff0000' });
    next.set(2, 0, 'c', { bold: true });
    expect(diff(prev, next, 'truecolor')).toBe(
      '\x1b[1;1H\x1b[0;38;2;255;0;0;49mab\x1b[0;1;39;49mc',
    );
  });

  it('returns an empty string when nothing changed', () => {
    const prev = new ScreenBuffer(3, 1);
    expect(diff(prev, prev.clone(), 'truecolor')).toBe('');
  });

  it('skips the cursor move for adjacent changes', () => {
    const prev = new ScreenBuffer(4, 1);
    const next = prev.clone();
    next.text(1, 0, 'ab');
    expect(diff(prev, next, 'none')).toBe('\x1b[1;2H\x1b[0mab');
  });
});

describe('toAnsiLines', () => {
  it('colours each row and resets at the end', () => {
    const buf = new ScreenBuffer(2, 1);
    buf.text(0, 0, 'ok', { fg: '#00ff00', bold: true });
    expect(toAnsiLines(buf, 'truecolor')).toEqual(['\x1b[0;1;38;2;0;255;0;49mok\x1b[0m']);
    expect(toAnsiLines(buf, 'none')).toEqual(['ok']);
  });
});
