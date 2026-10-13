export type Key =
  | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'tab' | 'backtab' | 'enter' | 'escape' | 'backspace';
export type InputEvent =
  | { type: 'key'; key: Key }
  | { type: 'char'; char: string }
  | { type: 'ctrl'; char: string }
  | { type: 'mouse'; action: 'move' | 'press' | 'release' | 'wheelup' | 'wheeldown'; x: number; y: number; button: number };

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
// ECMA-48 CSI: parameter bytes, intermediate bytes, one final byte.
const CSI = /^\x1b\[([0-?]*)[ -/]*([@-~])/;

const FINAL_KEYS: Record<string, Key> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'backtab' };
const TILDE_KEYS: Record<string, Key> = { '1': 'home', '7': 'home', '4': 'end', '8': 'end', '5': 'pageup', '6': 'pagedown' };

function mouseEvent(match: RegExpExecArray): InputEvent | null {
  const b = Number(match[1]);
  const x = Number(match[2]) - 1;
  const y = Number(match[3]) - 1;
  if (b & 64) {
    // Wheel: low bits 0/1 are up/down; 2/3 are horizontal wheels, which the UI does not use.
    const low = b & 3;
    if (low > 1) return null;
    return { type: 'mouse', action: low === 0 ? 'wheelup' : 'wheeldown', x, y, button: b };
  }
  if (match[4] === 'm') return { type: 'mouse', action: 'release', x, y, button: b };
  if (b & 32) return { type: 'mouse', action: 'move', x, y, button: b & ~32 };
  return { type: 'mouse', action: 'press', x, y, button: b };
}

// A CSI that has started (parameter and intermediate bytes) but not yet received its final byte.
const CSI_PREFIX = /^\x1b\[[0-?]*[ -/]*$/;

export interface InputDecoder {
  /** Decodes a chunk; an incomplete trailing escape sequence is kept for the next call. */
  feed(chunk: string): InputEvent[];
  /** Gives up on buffered input: a lone ESC becomes `escape`, any other incomplete sequence is dropped. */
  flush(): InputEvent[];
  /** True while a lone ESC is buffered (a bare Esc key press or the start of a split sequence). */
  hasPendingEscape(): boolean;
}

/** Stateful decoder for a stdin stream: a chunk may end in the middle of an escape sequence. */
export function createInputDecoder(): InputDecoder {
  let pending = '';
  return {
    feed(chunk) {
      const data = pending + chunk;
      const { events, rest } = decodeChunk(data);
      pending = rest;
      return events;
    },
    flush() {
      const lone = pending === '\x1b';
      pending = '';
      return lone ? [{ type: 'key', key: 'escape' }] : [];
    },
    hasPendingEscape: () => pending === '\x1b',
  };
}

/** Decodes one complete raw stdin chunk. Mouse x/y are 0-based. Unknown sequences are dropped. */
export function decodeInput(chunk: string): InputEvent[] {
  const decoder = createInputDecoder();
  return [...decoder.feed(chunk), ...decoder.flush()];
}

function decodeChunk(chunk: string): { events: InputEvent[]; rest: string } {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i]!;
    if (ch === '\x1b') {
      const rest = chunk.slice(i);
      const next = rest[1];
      if (next === undefined) return { events, rest };
      if (next === '\x1b') {
        events.push({ type: 'key', key: 'escape' });
        i += 1;
      } else if (next === '[') {
        const mouse = SGR_MOUSE.exec(rest);
        if (mouse) {
          const event = mouseEvent(mouse);
          if (event) events.push(event);
          i += mouse[0].length;
          continue;
        }
        const csi = CSI.exec(rest);
        if (!csi) {
          if (CSI_PREFIX.test(rest)) return { events, rest }; // final byte not arrived yet
          i += 2; // malformed: drop the introducer, keep what follows
          continue;
        }
        const final = csi[2]!;
        const key = final === '~' ? TILDE_KEYS[csi[1]!.split(';')[0]!] : FINAL_KEYS[final];
        if (key) events.push({ type: 'key', key });
        i += csi[0].length;
      } else if (next === 'O') {
        if (rest.length < 3) return { events, rest };
        const key = FINAL_KEYS[rest[2]!];
        if (key && rest[2] !== 'Z') events.push({ type: 'key', key });
        i += 3;
      } else {
        // Alt+key: report the escape and let the next iteration decode the key itself.
        events.push({ type: 'key', key: 'escape' });
        i += 1;
      }
      continue;
    }
    const code = chunk.codePointAt(i)!;
    if (ch === '\t') events.push({ type: 'key', key: 'tab' });
    else if (ch === '\r' || ch === '\n') events.push({ type: 'key', key: 'enter' });
    else if (code === 0x7f || code === 0x08) events.push({ type: 'key', key: 'backspace' });
    else if (code < 0x20) events.push({ type: 'ctrl', char: String.fromCharCode(code + 96) });
    else events.push({ type: 'char', char: String.fromCodePoint(code) });
    i += code > 0xffff ? 2 : 1;
  }
  return { events, rest: '' };
}
