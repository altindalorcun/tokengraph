import { format } from 'node:util';
import { setPromptHandler } from '../prompt.js';
import { setSpinnerRedirect, type Spinner } from '../spinner.js';
import type { TaskAfter, TaskAnswer } from './task-panel.js';
import { narrow } from './text-width.js';

/** A question a command asks while it runs in the box. */
export type TaskPromptRequest =
  | { kind: 'confirm'; question: string; defaultYes: boolean }
  | { kind: 'text'; question: string }
  | { kind: 'choice'; question: string; choices: readonly string[]; defaultIndex: number };

/** What a task session reports to the view, in the order it happens. */
export type TaskEvent =
  | { kind: 'started' }
  | { kind: 'line'; text: string; tone: 'out' | 'err' }
  | { kind: 'spinner'; text: string | null }
  | { kind: 'prompt'; prompt: TaskPromptRequest }
  /** Whether Esc can stop the command now. */
  | { kind: 'cancellable'; value: boolean }
  /** `cancelled`: the person cancelled and the command did not succeed, so it ended as asked rather than failed. */
  | { kind: 'done'; code: number; after: TaskAfter; cancelled: boolean };

/** What a command running in the box gets besides the console and the prompts. */
export interface TaskContext {
  /** Aborted when the person presses Esc while the command said it can stop. */
  signal: AbortSignal;
  /** Says whether Esc can stop the command right now (login only while it waits for GitHub). */
  cancellable(on: boolean): void;
  /** One line of output from outside the console, such as a child process. */
  print(line: string): void;
  /** What the command is waiting on, on the box's busy line; null for the plain one. */
  busy(text: string | null): void;
}

export interface TaskOutcome {
  code: number;
  /** What closing the box leads to; 'reload' when left out. */
  after?: TaskAfter;
}

export type TaskRun = (context: TaskContext) => Promise<TaskOutcome>;

export interface TaskSession {
  /** Answers the open question; ignored when there is none. */
  answer(value: TaskAnswer): void;
  /** Asks the command to stop (see `TaskContext.signal`). */
  cancel(): void;
  /** Puts the console, the prompts and the spinner back; no event arrives after this. */
  stop(): void;
}

// CSI (colours, cursor moves), OSC (titles, links) and the other two-byte escapes, in that order.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
// What is left of C0 and C1 after tabs are expanded, plus DEL.
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * One printed line as the box can draw it: the last state of a line redrawn with \r (npm's progress), without
 * colours, cursor moves or other control characters, tabs as spaces, and every character one column wide
 * (`narrow`: wide ones get a stand-in, zero-width ones go), so the box's border stays in line.
 */
export function cleanLine(raw: string): string {
  const redrawn = raw.replace(/\r+$/, '');
  const last = redrawn.slice(redrawn.lastIndexOf('\r') + 1);
  return narrow(last.replace(ESCAPES, '').replaceAll('\t', '    ').replace(CONTROLS, '')).trimEnd();
}

type Pending =
  | { kind: 'confirm'; resolve: (value: boolean) => void }
  | { kind: 'text'; resolve: (value: string) => void }
  | { kind: 'choice'; resolve: (value: number | null) => void };

const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const;

/**
 * Runs a command for the task box. While it runs, the console, every prompt (`prompt.ts`) and the spinner of a
 * sync report to `emit`, line by line as they happen, so nothing reaches the terminal the view has taken over.
 * A throw becomes a failed run with the message as its last line. Everything is put back when the command ends.
 */
export function startTaskSession(run: TaskRun, emit: (event: TaskEvent) => void): TaskSession {
  let stopped = false;
  let restored = false;
  let pending: Pending | null = null;
  const controller = new AbortController();
  const send = (event: TaskEvent): void => {
    if (!stopped) emit(event);
  };
  const print = (text: string, tone: 'out' | 'err'): void => {
    for (const line of text.split('\n')) send({ kind: 'line', text: cleanLine(line), tone });
  };

  const original = Object.fromEntries(CONSOLE_METHODS.map((name) => [name, console[name]])) as Pick<Console, (typeof CONSOLE_METHODS)[number]>;
  for (const name of CONSOLE_METHODS) {
    const tone = name === 'warn' || name === 'error' ? 'err' : 'out';
    console[name] = (...args: unknown[]): void => print(format(...args), tone);
  }
  const ask = <T>(prompt: Extract<TaskEvent, { kind: 'prompt' }>, make: (resolve: (value: T) => void) => Pending, cancelled: T): Promise<T> => {
    if (stopped) return Promise.resolve(cancelled);
    return new Promise<T>((resolve) => {
      pending = make(resolve);
      send(prompt);
    });
  };
  setPromptHandler({
    yesNo: (question, defaultYes) =>
      ask<boolean>({ kind: 'prompt', prompt: { kind: 'confirm', question: cleanLine(question.trim()), defaultYes } }, (resolve) => ({ kind: 'confirm', resolve }), false),
    text: (question) => ask<string>({ kind: 'prompt', prompt: { kind: 'text', question: cleanLine(question.trim()) } }, (resolve) => ({ kind: 'text', resolve }), ''),
    choice: (question, choices, defaultIndex) =>
      ask<number | null>(
        { kind: 'prompt', prompt: { kind: 'choice', question: cleanLine(question.trim()), choices: choices.map(cleanLine), defaultIndex } },
        (resolve) => ({ kind: 'choice', resolve }),
        null,
      ),
  });
  const spinner: Spinner = {
    start: (text) => send({ kind: 'spinner', text: cleanLine(text) }),
    // The box keeps the line until the spinner stops: a terminal spinner's next frame would draw it again anyway.
    clear: () => {},
    stop: () => send({ kind: 'spinner', text: null }),
  };
  setSpinnerRedirect(() => spinner);

  const restore = (): void => {
    if (restored) return;
    restored = true;
    Object.assign(console, original);
    setPromptHandler(null);
    setSpinnerRedirect(null);
  };
  /** Settles an open question with the answer that means cancel, so a stopped command does not hang. */
  const settle = (value: TaskAnswer): void => {
    const open = pending;
    if (!open) return;
    pending = null;
    if (open.kind === 'confirm') open.resolve(value === true);
    else if (open.kind === 'text') open.resolve(typeof value === 'string' ? value : '');
    else open.resolve(typeof value === 'number' ? value : null);
  };

  const context: TaskContext = {
    signal: controller.signal,
    cancellable: (on) => send({ kind: 'cancellable', value: on }),
    print: (line) => print(line, 'out'),
    busy: (text) => send({ kind: 'spinner', text: text === null ? null : cleanLine(text) }),
  };

  const go = async (): Promise<void> => {
    send({ kind: 'started' });
    let outcome: TaskOutcome;
    try {
      outcome = await run(context);
    } catch (error) {
      print(error instanceof Error ? error.message : String(error), 'err');
      outcome = { code: 1 };
    } finally {
      restore();
    }
    send({ kind: 'done', code: outcome.code, after: outcome.after ?? 'reload', cancelled: controller.signal.aborted && outcome.code !== 0 });
  };
  // On the next microtask, so the caller holds the session before its first event arrives.
  void Promise.resolve().then(go);

  return {
    answer: (value) => settle(value),
    cancel: () => controller.abort(),
    stop() {
      if (stopped) return;
      stopped = true;
      restore();
      controller.abort();
      settle(null);
    },
  };
}
