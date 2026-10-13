import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { askYesNo } from '../src/prompt.js';

function io(answer: string, tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = new PassThrough();
  setTimeout(() => input.write(`${answer}\n`), 5);
  return { input, output };
}

describe('askYesNo', () => {
  it('reads yes, no and the default', async () => {
    expect(await askYesNo('Go?', { io: io('y') })).toBe(true);
    expect(await askYesNo('Go?', { io: io('n') })).toBe(false);
    expect(await askYesNo('Go?', { io: io('') })).toBe(true);
    expect(await askYesNo('Go?', { defaultYes: false, io: io('') })).toBe(false);
  });

  it('returns the default when the input ends before an answer', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    setTimeout(() => input.end(), 5);
    expect(await askYesNo('Go?', { io: { input, output } })).toBe(true);
    const input2 = Object.assign(new PassThrough(), { isTTY: true });
    setTimeout(() => input2.end(), 5);
    expect(await askYesNo('Go?', { defaultYes: false, io: { input: input2, output: new PassThrough() } })).toBe(false);
  });

  it('never blocks without a terminal', async () => {
    expect(await askYesNo('Go?', { io: io('', false) })).toBe(true);
  });
});
