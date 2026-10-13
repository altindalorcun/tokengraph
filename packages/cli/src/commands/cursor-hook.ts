import type { Readable } from 'node:stream';
import { appendCursorEvent, eventFromHookPayload } from '../adapters/cursor/events.js';

/**
 * How long the hook waits for Cursor to close stdin. Cursor is expected to close it right
 * after writing the payload, but a held-open pipe (or a human running this by hand in a
 * terminal) must not hang the hook — Cursor is waiting on `{}` before it can proceed.
 */
export const STDIN_TIMEOUT_MS = 3000;

export interface CursorHookDeps {
  now?: () => Date;
  readStdin?: () => Promise<string>;
  writeStdout?: (text: string) => void;
}

/** True once `text` parses as a complete JSON object — the shape every Cursor payload takes. */
function isCompleteJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Reads whatever text arrives on `stream` within `ms`, resolving with the partial (or empty)
 * result instead of throwing or hanging if the stream never ends. A TTY (someone running the
 * command by hand) never carries a payload, so it resolves immediately without waiting.
 *
 * Cursor is expected to close stdin right after writing the payload, but some environments hold
 * the pipe open — waiting out the full timeout there would needlessly delay every hook run. So
 * the accumulated text is re-checked after each chunk, and a complete JSON object resolves right
 * away instead of waiting for 'end' or the timeout.
 */
export function readStdinWithTimeout(stream: Readable & { isTTY?: boolean }, ms: number): Promise<string> {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onEnd);
      // A pipe held open past this point can still emit 'error' later; with no listener that
      // would be an unhandled 'error' event (an uncaught exception). Keep a no-op one instead.
      stream.on('error', () => undefined);
      resolve(raw);
    };
    const onData = (chunk: unknown): void => {
      raw += String(chunk);
      if (isCompleteJsonObject(raw)) finish();
    };
    const onEnd = (): void => finish();
    const timer = setTimeout(onEnd, ms);
    timer.unref?.();
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
  });
}

async function readAllStdin(): Promise<string> {
  return readStdinWithTimeout(process.stdin, STDIN_TIMEOUT_MS);
}

/**
 * Runs as Cursor's `stop` hook. Cursor requires JSON on stdout and treats any failure as
 * "proceed", but a broken hook would still be noise in the user's session — so every step is
 * best-effort and the hook always answers `{}` and exits 0.
 *
 * The hook only records the turn locally; it never publishes. Publishing happens when the user
 * runs `tokengraph sync` (for example once at the end of the day), the same as Claude Code
 * and Codex.
 */
export async function runCursorHook(deps: CursorHookDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  try {
    const raw = await (deps.readStdin ?? readAllStdin)();
    let payload: unknown = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    const event = eventFromHookPayload(payload, now);
    if (event) await appendCursorEvent(event);
  } catch {
    // Best-effort by design: see above.
  }
  writeStdout('{}');
  return 0;
}
