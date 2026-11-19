import type { Readable } from 'node:stream';

/**
 * Passes what a child process prints to `onLine`, one line at a time, as it arrives. Used when the terminal view
 * runs a command: the child must not write to a screen the view owns, so its output goes to the view's task box.
 */
export function forwardLines(stream: Readable | null | undefined, onLine: (line: string) => void): void {
  if (!stream) return;
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) onLine(part);
  });
  stream.on('end', () => {
    if (rest !== '') onLine(rest);
    rest = '';
  });
}
