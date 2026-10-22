import type { ColorDepth } from './color.js';
import { createInputDecoder, type InputEvent } from './input.js';

// How long a lone ESC waits for the rest of an escape sequence before it counts as the Esc key.
const ESCAPE_TIMEOUT_MS = 50;

const ALT_SCREEN_ON = '\x1b[?1049h\x1b[?25l';
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const CLEAR = '\x1b[2J';

export const ENTER_SEQUENCE = `${ALT_SCREEN_ON}${MOUSE_ON}${CLEAR}`;
// Always disables the mouse modes, even when they were never enabled: it is harmless and keeps one restore path.
export const LEAVE_SEQUENCE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l';

const TRUECOLOR_PROGRAMS = new Set(['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper']);

/** Picks how many colours to emit from the environment, honouring FORCE_COLOR and NO_COLOR. */
export function detectColorDepth(env: NodeJS.ProcessEnv, isTTY: boolean): ColorDepth {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0') return 'none';
    if (force === '1') return '16';
    if (force === '2') return '256';
    if (force === '3') return 'truecolor';
    if (force === '' || force === 'true') return '16';
  }
  if (env.NO_COLOR) return 'none';
  if (!isTTY) return 'none';
  if (env.TERM === 'dumb') return 'none';
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  if (env.TERM_PROGRAM && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) return 'truecolor';
  if (env.TERM?.includes('256')) return '256';
  return '16';
}

export interface TerminalIO {
  stdin: Pick<NodeJS.ReadStream, 'on' | 'off' | 'setRawMode' | 'resume' | 'pause' | 'setEncoding'> & { isTTY?: boolean };
  stdout: Pick<NodeJS.WriteStream, 'write' | 'on' | 'off'> & { columns?: number; rows?: number };
}

export interface Terminal {
  readonly width: number;
  readonly height: number;
  write(text: string): void;
  onInput(listener: (events: InputEvent[]) => void): void;
  onResize(listener: (width: number, height: number) => void): void;
  /** Leaves the alternate screen and restores the cursor, mouse and raw mode. Safe to call twice. */
  restore(): void;
  /** Hands the terminal back to the shell (normal screen, cooked mode, no input delivered) so a command can print and prompt. */
  suspend(): void;
  /** Takes the terminal over again after `suspend`. */
  resume(): void;
}

/** Takes over the terminal (alternate screen, raw mode, optional mouse) and returns a handle that undoes it. */
export function openTerminal(io: TerminalIO, options: { mouse?: boolean } = {}): Terminal {
  const { stdin, stdout } = io;
  const dataListeners: Array<(chunk: string | Buffer) => void> = [];
  const resizeListeners: Array<() => void> = [];
  let restored = false;
  let suspended = false;
  const decoder = createInputDecoder();
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;

  stdin.setEncoding('utf8');
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const enter = options.mouse === false ? `${ALT_SCREEN_ON}${CLEAR}` : ENTER_SEQUENCE;
  stdout.write(enter);

  // Signals that terminate the process skip 'exit' handlers, so restore explicitly and exit with the shell's 128+n code.
  const onSigterm = (): void => { restore(); process.exit(143); };
  const onSigint = (): void => { restore(); process.exit(130); };
  const onSighup = (): void => { restore(); process.exit(129); };

  function restore(): void {
    if (restored) return;
    restored = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = undefined;
    process.off('exit', restore);
    process.off('SIGTERM', onSigterm);
    process.off('SIGHUP', onSighup);
    process.off('SIGINT', onSigint);
    for (const listener of dataListeners) stdin.off('data', listener);
    for (const listener of resizeListeners) stdout.off('resize', listener);
    // Each step is independent: a broken stdout must not leave the terminal in raw mode, and restore never throws.
    try { stdout.write(LEAVE_SEQUENCE); } catch { /* terminal already gone */ }
    try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* ignore */ }
    try { stdin.pause(); } catch { /* ignore */ }
  }
  function suspend(): void {
    if (restored || suspended) return;
    suspended = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = undefined;
    // A cooked-mode prompt reads stdin itself; the TUI must not see (or swallow) those keystrokes.
    for (const listener of dataListeners) stdin.off('data', listener);
    try { stdout.write(LEAVE_SEQUENCE); } catch { /* terminal already gone */ }
    try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* ignore */ }
    try { stdin.pause(); } catch { /* ignore */ }
  }

  function resume(): void {
    if (restored || !suspended) return;
    suspended = false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdout.write(enter);
    for (const listener of dataListeners) stdin.on('data', listener);
  }
  process.once('exit', restore);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);
  process.once('SIGINT', onSigint);

  return {
    get width() { return stdout.columns ?? 80; },
    get height() { return stdout.rows ?? 24; },
    write: (text) => { stdout.write(text); },
    onInput(listener) {
      if (restored) return;
      const onData = (chunk: string | Buffer): void => {
        if (escapeTimer) clearTimeout(escapeTimer);
        escapeTimer = undefined;
        const events = decoder.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        if (events.length > 0) listener(events);
        // A bare Esc key press arrives as a lone ESC; wait briefly for the rest of a possible split sequence.
        if (decoder.hasPendingEscape()) {
          escapeTimer = setTimeout(() => {
            escapeTimer = undefined;
            const flushed = decoder.flush();
            if (flushed.length > 0 && !restored) listener(flushed);
          }, ESCAPE_TIMEOUT_MS);
        }
      };
      dataListeners.push(onData);
      if (!suspended) stdin.on('data', onData);
    },
    onResize(listener) {
      if (restored) return;
      const onResize = (): void => listener(stdout.columns ?? 80, stdout.rows ?? 24);
      resizeListeners.push(onResize);
      stdout.on('resize', onResize);
    },
    restore,
    suspend,
    resume,
  };
}
