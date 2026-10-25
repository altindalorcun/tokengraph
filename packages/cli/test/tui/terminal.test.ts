import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ENTER_SEQUENCE, LEAVE_SEQUENCE, detectColorDepth, openTerminal } from '../../src/tui/terminal.js';

describe('detectColorDepth', () => {
  it('follows FORCE_COLOR, NO_COLOR, TTY, COLORTERM and TERM', () => {
    expect(detectColorDepth({ FORCE_COLOR: '3' }, false)).toBe('truecolor');
    expect(detectColorDepth({ FORCE_COLOR: '0', COLORTERM: 'truecolor' }, true)).toBe('none');
    expect(detectColorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe('none');
    expect(detectColorDepth({ COLORTERM: 'truecolor' }, false)).toBe('none');
    expect(detectColorDepth({ COLORTERM: '24bit' }, true)).toBe('truecolor');
    expect(detectColorDepth({ TERM: 'xterm-256color' }, true)).toBe('256');
    expect(detectColorDepth({ TERM: 'dumb' }, true)).toBe('none');
    expect(detectColorDepth({ TERM: 'xterm' }, true)).toBe('16');
    expect(detectColorDepth({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }, true)).toBe('truecolor');
  });
});

function fakeIO() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    raw: false,
    setRawMode(mode: boolean) { this.raw = mode; return this; },
    resume() { return this; },
    pause() { return this; },
    setEncoding() { return this; },
  });
  const written: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 100, rows: 30, write: (s: string) => (written.push(s), true) });
  return { stdin, stdout, written };
}

describe('openTerminal', () => {
  it('enters raw mode, forwards input and resize, and restores once', () => {
    const io = fakeIO();
    const term = openTerminal(io as never);
    expect(io.stdin.raw).toBe(true);
    expect(term.width).toBe(100);
    const seen: unknown[] = [];
    term.onInput((events) => seen.push(...events));
    io.stdin.emit('data', 'q');
    expect(seen).toEqual([{ type: 'char', char: 'q' }]);
    let size: number[] = [];
    term.onResize((w, h) => (size = [w, h]));
    io.stdout.columns = 120;
    io.stdout.emit('resize');
    expect(size).toEqual([120, 30]);
    term.restore();
    term.restore();
    expect(io.written.filter((s) => s.includes(LEAVE_SEQUENCE))).toHaveLength(1);
    expect(io.stdin.raw).toBe(false);
    expect(io.stdin.listenerCount('data')).toBe(0);
    expect(io.stdout.listenerCount('resize')).toBe(0);
  });

  it('suspends: leaves the alternate screen, drops input, and resumes where it left off', () => {
    const io = fakeIO();
    const term = openTerminal(io as never);
    const seen: unknown[] = [];
    term.onInput((events) => seen.push(...events));
    io.written.length = 0;
    term.suspend();
    expect(io.written).toEqual([LEAVE_SEQUENCE]);
    expect(io.stdin.raw).toBe(false);
    io.stdin.emit('data', 'x');
    expect(seen).toEqual([]);
    term.suspend();
    expect(io.written).toHaveLength(1);
    term.resume();
    expect(io.written.at(-1)).toBe(ENTER_SEQUENCE);
    expect(io.stdin.raw).toBe(true);
    io.stdin.emit('data', 'y');
    expect(seen).toEqual([{ type: 'char', char: 'y' }]);
    term.resume();
    expect(io.written.filter((s) => s === ENTER_SEQUENCE)).toHaveLength(1);
  });

  it('restores while suspended and ignores resume afterwards', () => {
    const io = fakeIO();
    const term = openTerminal(io as never);
    term.onInput(() => {});
    term.suspend();
    expect(() => term.restore()).not.toThrow();
    expect(io.stdin.listenerCount('data')).toBe(0);
    const writes = io.written.length;
    term.resume();
    term.suspend();
    expect(io.written).toHaveLength(writes);
    expect(io.stdin.raw).toBe(false);
  });

  it('skips the mouse modes when mouse is off', () => {
    const io = fakeIO();
    const term = openTerminal(io as never, { mouse: false });
    expect(io.written[0]).not.toContain('?1000h');
    expect(io.written[0]).toContain('?1049h');
    term.restore();
  });

  it('registers exit, SIGTERM, SIGHUP and SIGINT handlers on open and removes them on restore', () => {
    const before = { exit: process.listenerCount('exit'), term: process.listenerCount('SIGTERM'), hup: process.listenerCount('SIGHUP'), int: process.listenerCount('SIGINT') };
    const term = openTerminal(fakeIO() as never);
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    term.restore();
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
  });

  it('still leaves raw mode and pauses stdin when writing the leave sequence throws', () => {
    const io = fakeIO();
    let paused = false;
    io.stdin.pause = () => { paused = true; return io.stdin; };
    const term = openTerminal(io as never);
    io.stdout.write = () => { throw new Error('EIO'); };
    expect(() => term.restore()).not.toThrow();
    expect(io.stdin.raw).toBe(false);
    expect(paused).toBe(true);
  });

  it('delivers a lone ESC chunk as escape only after the timer, and joins a split sequence', () => {
    vi.useFakeTimers();
    try {
      const io = fakeIO();
      const term = openTerminal(io as never);
      const seen: unknown[] = [];
      term.onInput((events) => seen.push(...events));
      io.stdin.emit('data', '\x1b');
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(60);
      expect(seen).toEqual([{ type: 'key', key: 'escape' }]);
      seen.length = 0;
      io.stdin.emit('data', '\x1b');
      vi.advanceTimersByTime(10);
      io.stdin.emit('data', '[A');
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([{ type: 'key', key: 'up' }]);
      seen.length = 0;
      io.stdin.emit('data', '\x1b');
      term.restore();
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores onInput and onResize after restore', () => {
    const io = fakeIO();
    const term = openTerminal(io as never);
    term.restore();
    term.onInput(() => {});
    term.onResize(() => {});
    expect(io.stdin.listenerCount('data')).toBe(0);
    expect(io.stdout.listenerCount('resize')).toBe(0);
  });
});
