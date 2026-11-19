import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { forwardLines } from '../src/child-output.js';

describe('forwardLines', () => {
  it('passes each line on as it arrives, joining chunks split mid-line, and a last line without a newline at the end', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    forwardLines(stream, (line) => lines.push(line));
    stream.write('added 1 pack');
    stream.write('age\nchanged ');
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(['added 1 package']);
    stream.end('2 packages');
    await new Promise((resolve) => stream.on('end', resolve));
    expect(lines).toEqual(['added 1 package', 'changed 2 packages']);
  });

  it('does nothing without a stream', () => {
    expect(() => forwardLines(null, () => {})).not.toThrow();
  });
});
