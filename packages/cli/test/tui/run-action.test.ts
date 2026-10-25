import { describe, expect, it } from 'vitest';
import { captureOutput } from '../../src/tui/run-action.js';

describe('captureOutput', () => {
  it('collects console output and restores the console', async () => {
    const log = console.log;
    const result = await captureOutput(async () => {
      console.log('one');
      console.info('two');
      console.warn('three');
      console.error('four', 4);
      return 0;
    });
    expect(result).toEqual({ code: 0, lines: ['one', 'two', 'three', 'four 4'] });
    expect(console.log).toBe(log);
  });

  it('turns a throw into code 1 with the message as the last line', async () => {
    const log = console.log;
    const result = await captureOutput(async () => {
      console.log('before');
      throw new Error('boom');
    });
    expect(result).toEqual({ code: 1, lines: ['before', 'boom'] });
    expect(console.log).toBe(log);
  });

  it('splits multi-line output into lines', async () => {
    const result = await captureOutput(async () => (console.log('a\nb'), 2));
    expect(result).toEqual({ code: 2, lines: ['a', 'b'] });
  });
});
