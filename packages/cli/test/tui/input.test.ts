import { describe, expect, it } from 'vitest';
import { createInputDecoder, decodeInput } from '../../src/tui/input.js';

describe('decodeInput', () => {
  it('decodes keys', () => {
    expect(decodeInput('\x1b[A\x1b[B\x1b[C\x1b[D')).toEqual([
      { type: 'key', key: 'up' }, { type: 'key', key: 'down' }, { type: 'key', key: 'right' }, { type: 'key', key: 'left' },
    ]);
    expect(decodeInput('\x1bOA')).toEqual([{ type: 'key', key: 'up' }]);
    expect(decodeInput('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[5~\x1b[6~')).toEqual([
      { type: 'key', key: 'home' }, { type: 'key', key: 'end' }, { type: 'key', key: 'home' },
      { type: 'key', key: 'end' }, { type: 'key', key: 'pageup' }, { type: 'key', key: 'pagedown' },
    ]);
    expect(decodeInput('\t\x1b[Z\r\x7f')).toEqual([
      { type: 'key', key: 'tab' }, { type: 'key', key: 'backtab' }, { type: 'key', key: 'enter' }, { type: 'key', key: 'backspace' },
    ]);
    expect(decodeInput('\x1b')).toEqual([{ type: 'key', key: 'escape' }]);
  });

  it('decodes characters and control keys', () => {
    expect(decodeInput('q1[')).toEqual([
      { type: 'char', char: 'q' }, { type: 'char', char: '1' }, { type: 'char', char: '[' },
    ]);
    expect(decodeInput('\x03')).toEqual([{ type: 'ctrl', char: 'c' }]);
  });

  it('decodes SGR mouse events with 0-based coordinates', () => {
    expect(decodeInput('\x1b[<0;10;5M')).toEqual([{ type: 'mouse', action: 'press', x: 9, y: 4, button: 0 }]);
    expect(decodeInput('\x1b[<0;10;5m')).toEqual([{ type: 'mouse', action: 'release', x: 9, y: 4, button: 0 }]);
    expect(decodeInput('\x1b[<35;3;2M')).toEqual([{ type: 'mouse', action: 'move', x: 2, y: 1, button: 3 }]);
    expect(decodeInput('\x1b[<64;1;1M\x1b[<65;1;1M')).toEqual([
      { type: 'mouse', action: 'wheelup', x: 0, y: 0, button: 64 },
      { type: 'mouse', action: 'wheeldown', x: 0, y: 0, button: 65 },
    ]);
  });

  it('drops unknown escape sequences without eating the next key', () => {
    expect(decodeInput('\x1b[99Xq')).toEqual([{ type: 'char', char: 'q' }]);
  });

  it('emits one char per code point and keeps order across mixed input', () => {
    expect(decodeInput('é😀')).toEqual([{ type: 'char', char: 'é' }, { type: 'char', char: '😀' }]);
    expect(decodeInput('a\x1b\x1b[Ab')).toEqual([
      { type: 'char', char: 'a' }, { type: 'key', key: 'escape' }, { type: 'key', key: 'up' }, { type: 'char', char: 'b' },
    ]);
  });
});

describe('createInputDecoder', () => {
  it('joins an SGR mouse report split across chunks', () => {
    const decoder = createInputDecoder();
    expect(decoder.feed('\x1b[<0;10;')).toEqual([]);
    expect(decoder.feed('5M')).toEqual([{ type: 'mouse', action: 'press', x: 9, y: 4, button: 0 }]);
    expect(decoder.flush()).toEqual([]);
  });

  it('joins ESC and [A split across chunks into one up key', () => {
    const decoder = createInputDecoder();
    expect(decoder.feed('\x1b')).toEqual([]);
    expect(decoder.hasPendingEscape()).toBe(true);
    expect(decoder.feed('[A')).toEqual([{ type: 'key', key: 'up' }]);
    expect(decoder.hasPendingEscape()).toBe(false);
  });

  it('holds a lone ESC until flush, which reports escape', () => {
    const decoder = createInputDecoder();
    expect(decoder.feed('\x1b')).toEqual([]);
    expect(decoder.flush()).toEqual([{ type: 'key', key: 'escape' }]);
    expect(decoder.flush()).toEqual([]);
  });

  it('buffers ESC O without its final byte and drops other incomplete buffers on flush', () => {
    const decoder = createInputDecoder();
    expect(decoder.feed('\x1bO')).toEqual([]);
    expect(decoder.feed('A')).toEqual([{ type: 'key', key: 'up' }]);
    expect(decoder.feed('\x1b[<0;1')).toEqual([]);
    expect(decoder.hasPendingEscape()).toBe(false);
    expect(decoder.flush()).toEqual([]);
    expect(decoder.feed('1')).toEqual([{ type: 'char', char: '1' }]);
  });
});
