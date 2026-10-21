import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpinner, FRAMES, spinnerEnabled } from '../src/spinner.js';

const CLEAR_LINE = '\r\x1b[2K';

function fakeStream() {
  const writes: string[] = [];
  return { writes, write: (text: string) => (writes.push(text), true) };
}

describe('spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws the first frame at once and advances on each tick', () => {
    const stream = fakeStream();
    const spinner = createSpinner(stream, { enabled: true, intervalMs: 80 });
    spinner.start('Reading Claude Code…');
    expect(stream.writes).toEqual([`${CLEAR_LINE}${FRAMES[0]} Reading Claude Code…`]);
    vi.advanceTimersByTime(80);
    expect(stream.writes.at(-1)).toBe(`${CLEAR_LINE}${FRAMES[1]} Reading Claude Code…`);
    spinner.stop();
  });

  it('changes its text in place when started again', () => {
    const stream = fakeStream();
    const spinner = createSpinner(stream, { enabled: true, intervalMs: 80 });
    spinner.start('one');
    spinner.start('two');
    expect(stream.writes.at(-1)).toBe(`${CLEAR_LINE}${FRAMES[0]} two`);
    vi.advanceTimersByTime(80);
    expect(stream.writes.at(-1)).toBe(`${CLEAR_LINE}${FRAMES[1]} two`);
    expect(vi.getTimerCount()).toBe(1);
    spinner.stop();
  });

  it('clear erases the line and the next tick draws it again', () => {
    const stream = fakeStream();
    const spinner = createSpinner(stream, { enabled: true, intervalMs: 80 });
    spinner.start('work');
    spinner.clear();
    expect(stream.writes.at(-1)).toBe(CLEAR_LINE);
    vi.advanceTimersByTime(80);
    expect(stream.writes.at(-1)).toBe(`${CLEAR_LINE}${FRAMES[1]} work`);
    spinner.stop();
  });

  it('stop erases the line, stops the frames and is safe to repeat', () => {
    const stream = fakeStream();
    const spinner = createSpinner(stream, { enabled: true, intervalMs: 80 });
    spinner.start('work');
    spinner.stop();
    expect(stream.writes.at(-1)).toBe(CLEAR_LINE);
    const count = stream.writes.length;
    spinner.stop();
    spinner.clear();
    vi.advanceTimersByTime(800);
    expect(stream.writes.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes nothing when disabled', () => {
    const stream = fakeStream();
    const spinner = createSpinner(stream, { enabled: false });
    spinner.start('work');
    vi.advanceTimersByTime(800);
    spinner.clear();
    spinner.stop();
    expect(stream.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('spinnerEnabled', () => {
  it('needs a terminal that understands escape codes', () => {
    expect(spinnerEnabled({ isTTY: true }, {})).toBe(true);
    expect(spinnerEnabled({ isTTY: false }, {})).toBe(false);
    expect(spinnerEnabled({}, {})).toBe(false);
    expect(spinnerEnabled({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(spinnerEnabled({ isTTY: true }, { CI: 'true' })).toBe(false);
  });
});
