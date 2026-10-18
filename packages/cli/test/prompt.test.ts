import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { askChoice, askYesNo } from '../src/prompt.js';

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

  it('treats an input that ends before an answer as no, whatever the default', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    setTimeout(() => input.end(), 5);
    expect(await askYesNo('Go?', { io: { input, output } })).toBe(false);
    const input2 = Object.assign(new PassThrough(), { isTTY: true });
    setTimeout(() => input2.end(), 5);
    expect(await askYesNo('Go?', { defaultYes: false, io: { input: input2, output: new PassThrough() } })).toBe(false);
  });

  it('never blocks without a terminal', async () => {
    expect(await askYesNo('Go?', { io: io('', false) })).toBe(true);
  });
});

describe('askChoice', () => {
  const choices = ['Today', '7 days', '30 days'];

  it('reads a number, takes the default on Enter, and lists the choices', async () => {
    expect(await askChoice('Period?', choices, { io: io('3') })).toBe(2);
    expect(await askChoice('Period?', choices, { io: io('') })).toBe(0);
    expect(await askChoice('Period?', choices, { defaultIndex: 1, io: io('') })).toBe(1);
    const shown = io('1');
    let text = '';
    shown.output.on('data', (chunk) => (text += String(chunk)));
    await askChoice('Period?', choices, { io: shown });
    expect(text).toContain('1) Today');
    expect(text).toContain('3) 30 days');
  });

  it('asks again after an answer outside the list', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    setTimeout(() => input.write('9\n'), 5);
    setTimeout(() => input.write('x\n'), 10);
    setTimeout(() => input.write('2\n'), 15);
    expect(await askChoice('Period?', choices, { io: { input, output: new PassThrough() } })).toBe(1);
  });

  it('returns null when the input ends before an answer, and the default without a terminal', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    setTimeout(() => input.end(), 5);
    expect(await askChoice('Period?', choices, { io: { input, output: new PassThrough() } })).toBeNull();
    expect(await askChoice('Period?', choices, { defaultIndex: 1, io: io('', false) })).toBe(1);
  });
});
