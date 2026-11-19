import type { ActionId } from './actions.js';
import type { InputEvent } from './input.js';
import type { TaskEvent, TaskPromptRequest } from './task-session.js';
import { narrow } from './text-width.js';

/** One line of a command's output; `input` echoes an answer the person gave in the box. */
export interface TaskLine {
  text: string;
  tone: 'out' | 'err' | 'input';
}

/**
 * A question the command is waiting on, with what the person has typed or picked so far. `openedAt` is on the app
 * clock (null without one): keys that arrive right after it opened were typed for the previous question.
 */
export type TaskPrompt = { openedAt: number | null } & (
  | { kind: 'confirm'; question: string; defaultYes: boolean }
  | { kind: 'text'; question: string; value: string; cursor: number }
  | { kind: 'choice'; question: string; choices: string[]; selected: number }
);

/** What closing a finished box leads to: the view reloads, starts the new version, or quits (the data is gone). */
export type TaskAfter = 'reload' | 'restart' | 'quit';

/**
 * The task box: a Setup or palette action running inside the view instead of on the normal screen. It shows the
 * command's output as it is printed, asks its questions, and stays until the person closes it once it is done.
 */
export interface TaskPanel {
  id: ActionId;
  title: string;
  /** False until the app has started the command (it waits for a scan or ledger write first). */
  started: boolean;
  lines: TaskLine[];
  /** `cancelled`: the person stopped it and it stopped; shown as a neutral end, not a failure. */
  status: 'running' | 'done' | 'failed' | 'cancelled';
  code: number | null;
  /** What a command's spinner says it is doing; null shows a plain busy line while running. */
  spinner: string | null;
  prompt: TaskPrompt | null;
  /** The first output row shown while `follow` is off. */
  scroll: number;
  /** Keep the newest output in view; off once the person scrolls up, on again at the bottom. */
  follow: boolean;
  /** The command can stop early right now (login while it waits for GitHub). */
  cancellable: boolean;
  cancelling: boolean;
  /**
   * Esc or Ctrl-C was pressed while a command that cannot stop was running: `esc` explains, `quit` also says a
   * second Ctrl-C quits tokengraph, armed at `quitArmedAt` on the app clock.
   */
  busyHint: 'esc' | 'quit' | null;
  quitArmedAt: number | null;
  after: TaskAfter;
}

/** A prompt's answer: a yes / no, a line of text ('' cancels), or a choice index (null cancels). */
export type TaskAnswer = boolean | string | number | null;

/** What the box asks the app to do. `quit` leaves tokengraph while a command that cannot stop still runs. */
export type TaskCommand =
  | { task: 'start'; id: ActionId }
  | { task: 'answer'; value: TaskAnswer }
  | { task: 'cancel' }
  | { task: 'close'; after: TaskAfter }
  | { task: 'quit' };

/** The rows the box shows and the rows the output fills, as drawn in the last frame. */
export interface TaskViewport {
  rows: number;
  total: number;
}

/** Older output is dropped beyond this, so a chatty command (npm) cannot grow the box without bound. */
export const MAX_LINES = 2000;
/**
 * While the person reads scrolled-up output nothing is dropped, since that would move the rows under them; past this
 * the oldest go anyway and the box returns to the newest output.
 */
export const MAX_LINES_SCROLLED = MAX_LINES * 2;
/** Enter, y, n or a digit this soon after a question opened was typed for the one before it, and is ignored. */
export const PROMPT_SETTLE_MS = 150;
/** A second Ctrl-C within this long of the first quits tokengraph while a command that cannot stop runs. */
export const QUIT_WINDOW_MS = 2000;
const WHEEL_ROWS = 3;

export function openTaskPanel(id: ActionId, title: string): TaskPanel {
  return {
    id,
    title,
    started: false,
    lines: [],
    status: 'running',
    code: null,
    spinner: null,
    prompt: null,
    scroll: 0,
    follow: true,
    cancellable: false,
    cancelling: false,
    busyHint: null,
    quitArmedAt: null,
    after: 'reload',
  };
}

const isEsc = (event: InputEvent): boolean => event.type === 'key' && event.key === 'escape';
const isCtrlC = (event: InputEvent): boolean => event.type === 'ctrl' && event.char === 'c';
const isCancel = (event: InputEvent): boolean => isEsc(event) || isCtrlC(event);

/** Moves the output by `step` rows (negative is up), or to the top or bottom; null when `event` is not a scroll key. */
function scrollStep(event: InputEvent, viewport: TaskViewport | null): number | 'top' | 'bottom' | null {
  const page = Math.max(1, (viewport?.rows ?? 1) - 1);
  if (event.type === 'mouse') {
    if (event.action === 'wheelup') return -WHEEL_ROWS;
    if (event.action === 'wheeldown') return WHEEL_ROWS;
    return null;
  }
  if (event.type !== 'key') return null;
  switch (event.key) {
    case 'up': return -1;
    case 'down': return 1;
    case 'pageup': return -page;
    case 'pagedown': return page;
    case 'home': return 'top';
    case 'end': return 'bottom';
    default: return null;
  }
}

function scrolled(panel: TaskPanel, step: number | 'top' | 'bottom', viewport: TaskViewport | null): TaskPanel {
  if (step === 'bottom') return { ...panel, follow: true };
  if (!viewport) return panel;
  const max = Math.max(0, viewport.total - viewport.rows);
  const from = panel.follow ? max : Math.min(panel.scroll, max);
  const top = step === 'top' ? 0 : Math.max(0, Math.min(max, from + step));
  return { ...panel, scroll: top, follow: top >= max };
}

type Out = { panel: TaskPanel; command: TaskCommand | null };

/** Closes the prompt with `value` and shows the question with its answer in the output. */
function answered(panel: TaskPanel, question: string, shown: string, value: TaskAnswer): Out {
  const lines = pushLines(panel.lines, [{ text: narrow(`${question} ${shown}`.trim()), tone: 'input' }], true);
  return { panel: { ...panel, prompt: null, lines, follow: true }, command: { task: 'answer', value } };
}

/** Keys that answer a question, and so must not come from typing ahead. */
function answers(prompt: TaskPrompt, event: InputEvent): boolean {
  if (event.type === 'key') return event.key === 'enter';
  if (event.type !== 'char') return false;
  if (prompt.kind === 'confirm') return /^[yYnN]$/.test(event.char);
  return prompt.kind === 'choice' && /^[1-9]$/.test(event.char);
}

function confirmKey(panel: TaskPanel, prompt: Extract<TaskPrompt, { kind: 'confirm' }>, event: InputEvent): Out | null {
  const yes = (): Out => answered(panel, prompt.question, 'Yes', true);
  const no = (): Out => answered(panel, prompt.question, 'No', false);
  if (isCancel(event)) return no();
  if (event.type === 'char' && (event.char === 'y' || event.char === 'Y')) return yes();
  if (event.type === 'char' && (event.char === 'n' || event.char === 'N')) return no();
  if (event.type === 'key' && event.key === 'enter') return prompt.defaultYes ? yes() : no();
  return null;
}

// A paste can carry tabs, newlines or stray escape bytes; none belongs in a path or a name.
const INPUT_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

function textKey(panel: TaskPanel, prompt: Extract<TaskPrompt, { kind: 'text' }>, event: InputEvent): Out | null {
  const chars = [...prompt.value];
  const edit = (value: string[], cursor: number): Out => ({
    panel: { ...panel, prompt: { ...prompt, value: value.join(''), cursor: Math.max(0, Math.min(value.length, cursor)) } },
    command: null,
  });
  if (isCancel(event)) return answered(panel, prompt.question, '(cancelled)', '');
  // A paste arrives as one char event per character, so it lands at the cursor like typing.
  if (event.type === 'char') {
    const typed = [...event.char.replace(INPUT_CONTROLS, '')];
    return edit([...chars.slice(0, prompt.cursor), ...typed, ...chars.slice(prompt.cursor)], prompt.cursor + typed.length);
  }
  if (event.type === 'ctrl') {
    if (event.char === 'u') return edit(chars.slice(prompt.cursor), 0);
    if (event.char === 'a') return edit(chars, 0);
    if (event.char === 'e') return edit(chars, chars.length);
    return { panel, command: null };
  }
  if (event.type !== 'key') return null;
  switch (event.key) {
    case 'enter': {
      const value = prompt.value.trim();
      return answered(panel, prompt.question, value === '' ? '(cancelled)' : value, value);
    }
    case 'backspace':
      return prompt.cursor === 0 ? { panel, command: null } : edit([...chars.slice(0, prompt.cursor - 1), ...chars.slice(prompt.cursor)], prompt.cursor - 1);
    case 'left': return edit(chars, prompt.cursor - 1);
    case 'right': return edit(chars, prompt.cursor + 1);
    case 'home': return edit(chars, 0);
    case 'end': return edit(chars, chars.length);
    // A tab in a path prompt would only confuse; nothing else edits the line.
    default: return null;
  }
}

function choiceKey(panel: TaskPanel, prompt: Extract<TaskPrompt, { kind: 'choice' }>, event: InputEvent): Out | null {
  const pick = (index: number): Out => answered(panel, prompt.question, prompt.choices[index]!, index);
  const move = (selected: number): Out => ({
    panel: { ...panel, prompt: { ...prompt, selected: Math.max(0, Math.min(prompt.choices.length - 1, selected)) } },
    command: null,
  });
  if (isCancel(event)) return answered(panel, prompt.question, '(cancelled)', null);
  if (event.type === 'char' && /^[1-9]$/.test(event.char)) {
    const index = Number(event.char) - 1;
    return index < prompt.choices.length ? pick(index) : { panel, command: null };
  }
  if (event.type !== 'key') return null;
  if (event.key === 'up') return move(prompt.selected - 1);
  if (event.key === 'down') return move(prompt.selected + 1);
  if (event.key === 'enter') return pick(prompt.selected);
  return null;
}

/** Esc or Ctrl-C while the command runs and no question is open. */
function runningCancel(panel: TaskPanel, event: InputEvent, now: number | null): Out {
  if (panel.cancellable && !panel.cancelling) return { panel: { ...panel, cancelling: true, busyHint: null, quitArmedAt: null }, command: { task: 'cancel' } };
  // Esc again while a cancel is under way changes nothing; the busy line already says it is cancelling.
  if (!isCtrlC(event)) return panel.cancelling ? { panel, command: null } : { panel: { ...panel, busyHint: panel.busyHint ?? 'esc' }, command: null };
  // The way out of a command that hangs (npm with no network): raw mode turns Ctrl-C into a key, so it never kills us.
  if (now !== null && panel.quitArmedAt !== null && now - panel.quitArmedAt <= QUIT_WINDOW_MS) return { panel, command: { task: 'quit' } };
  return { panel: { ...panel, busyHint: 'quit', quitArmedAt: now }, command: null };
}

/**
 * Keys while the box is open; nothing reaches the view behind it. An open question takes its keys first (Esc and
 * Ctrl-C answer it as cancel; an answer typed ahead for the previous question is ignored). Before the command has
 * started, Esc or Ctrl-C closes the box. While it runs, Esc stops it when it can stop and otherwise says it is still
 * running; Ctrl-C does the same, and a second Ctrl-C within two seconds quits tokengraph. Once finished, Enter, Esc
 * or Ctrl-C closes the box. `viewport` is the box as last drawn, for scrolling; `now` is the app clock (null in
 * tests that do not need one).
 */
export function taskKey(panel: TaskPanel, event: InputEvent, viewport: TaskViewport | null, now: number | null = null): Out {
  const prompt = panel.prompt;
  if (prompt) {
    if (now !== null && prompt.openedAt !== null && now - prompt.openedAt < PROMPT_SETTLE_MS && answers(prompt, event)) return { panel, command: null };
    const out =
      prompt.kind === 'confirm' ? confirmKey(panel, prompt, event) : prompt.kind === 'text' ? textKey(panel, prompt, event) : choiceKey(panel, prompt, event);
    if (out) return out;
  }
  const step = scrollStep(event, viewport);
  if (step !== null) return { panel: scrolled(panel, step, viewport), command: null };
  if (prompt) return { panel, command: null };
  if (panel.status === 'running') {
    if (!isCancel(event)) return { panel, command: null };
    // Still waiting for a scan (which may never end): nothing has run, so leaving is always safe.
    if (!panel.started) return { panel, command: { task: 'close', after: 'reload' } };
    return runningCancel(panel, event, now);
  }
  if (isCancel(event) || (event.type === 'key' && event.key === 'enter')) return { panel, command: { task: 'close', after: panel.after } };
  return { panel, command: null };
}

/** Appends `more`, keeping the newest MAX_LINES; while not `following`, only once MAX_LINES_SCROLLED is passed. */
function pushLines(lines: readonly TaskLine[], more: readonly TaskLine[], following: boolean): TaskLine[] {
  const next = [...lines, ...more];
  return next.length > (following ? MAX_LINES : MAX_LINES_SCROLLED) ? next.slice(next.length - MAX_LINES) : next;
}

function promptFor(request: TaskPromptRequest, now: number | null): TaskPrompt {
  switch (request.kind) {
    case 'confirm': return { kind: 'confirm', question: request.question, defaultYes: request.defaultYes, openedAt: now };
    case 'text': return { kind: 'text', question: request.question, value: '', cursor: 0, openedAt: now };
    case 'choice': return { kind: 'choice', question: request.question, choices: [...request.choices], selected: Math.max(0, Math.min(request.choices.length - 1, request.defaultIndex)), openedAt: now };
  }
}

/** Folds one session event into the box; `now` is the app clock, for the question's typed-ahead guard. */
export function applyTaskEvent(panel: TaskPanel, event: TaskEvent, now: number | null = null): TaskPanel {
  switch (event.kind) {
    case 'started':
      return { ...panel, started: true };
    case 'line': {
      const lines = pushLines(panel.lines, [{ text: event.text, tone: event.tone }], panel.follow);
      // Lines only drop above a scrolled view once it holds MAX_LINES_SCROLLED; the rows it showed are gone then.
      const dropped = panel.lines.length + 1 - lines.length;
      return dropped > 0 && !panel.follow ? { ...panel, lines, follow: true } : { ...panel, lines };
    }
    case 'spinner':
      return { ...panel, spinner: event.text };
    case 'prompt':
      // A question needs the person's eyes: bring the newest output, where it was asked, into view.
      return { ...panel, prompt: promptFor(event.prompt, now), follow: true, busyHint: null, quitArmedAt: null };
    case 'cancellable':
      // A command that can no longer stop (login past the approval) is not being cancelled any more either.
      return { ...panel, cancellable: event.value, cancelling: event.value ? panel.cancelling : false, busyHint: event.value ? null : panel.busyHint };
    case 'done':
      return {
        ...panel,
        status: event.cancelled ? 'cancelled' : event.code === 0 ? 'done' : 'failed',
        code: event.code,
        spinner: null,
        prompt: null,
        cancellable: false,
        cancelling: false,
        busyHint: null,
        quitArmedAt: null,
        after: event.after,
      };
  }
}
