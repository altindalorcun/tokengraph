/**
 * A one-line spinner for slow steps, so a quiet terminal does not look frozen. It draws on its own
 * stream (stderr), never between the lines a command prints: callers `clear()` before printing and
 * the next frame puts it back below.
 */

export const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const CLEAR_LINE = '\r\x1b[2K';

export interface Spinner {
  /** Shows the spinner beside `text`, or changes the text of a running one. */
  start(text: string): void;
  /** Erases the spinner's line; the next frame draws it again unless it is stopped. */
  clear(): void;
  /** Erases the line and stops the frames. Safe to call more than once. */
  stop(): void;
}

export interface SpinnerOptions {
  /** When false every method does nothing (no terminal, `--quiet`, a hook or schedule run). */
  enabled: boolean;
  intervalMs?: number;
}

/** Whether `stream` is a terminal that redraws a line in place: not piped, not `TERM=dumb`, not CI logs. */
export function spinnerEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return stream.isTTY === true && env['TERM'] !== 'dumb' && !env['CI'];
}

let redirect: (() => Spinner) | null = null;

/**
 * While set, `commandSpinner` hands out spinners from `factory` instead of drawing on a stream: the terminal view's
 * task box owns the screen and shows the spinner's text on its own status line.
 */
export function setSpinnerRedirect(factory: (() => Spinner) | null): void {
  redirect = factory;
}

/** The spinner a command shows while it works: the redirected one when the view runs the command, else `createSpinner`. */
export function commandSpinner(stream: { write(text: string): boolean }, options: SpinnerOptions): Spinner {
  return redirect ? redirect() : createSpinner(stream, options);
}

export function createSpinner(stream: { write(text: string): boolean }, options: SpinnerOptions): Spinner {
  if (!options.enabled) return { start: () => {}, clear: () => {}, stop: () => {} };
  let text = '';
  let frame = 0;
  let shown = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const draw = () => {
    stream.write(`${CLEAR_LINE}${FRAMES[frame % FRAMES.length]} ${text}`);
    shown = true;
  };
  const erase = () => {
    if (shown) stream.write(CLEAR_LINE);
    shown = false;
  };

  return {
    start(next) {
      text = next;
      draw();
      if (timer) return;
      timer = setInterval(() => {
        frame += 1;
        draw();
      }, options.intervalMs ?? 80);
      // A spinner never keeps the process alive on its own.
      timer.unref?.();
    },
    clear: erase,
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      erase();
    },
  };
}
