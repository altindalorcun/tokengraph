import { describe, expect, it } from 'vitest';
import type { InputEvent } from '../../src/tui/input.js';
import { ScreenBuffer, toPlainText } from '../../src/tui/screen.js';
import { applyTaskEvent, MAX_LINES, MAX_LINES_SCROLLED, openTaskPanel, taskKey, type TaskPanel } from '../../src/tui/task-panel.js';
import { charWidth, displayWidth, narrow } from '../../src/tui/text-width.js';
import type { TaskEvent } from '../../src/tui/task-session.js';
import { tuiTheme } from '../../src/tui/theme.js';
import { drawTask, tidyLines, wrapText } from '../../src/tui/views/task.js';

const key = (name: 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown' | 'enter' | 'escape' | 'backspace') => ({ type: 'key', key: name }) as const;
const char = (c: string) => ({ type: 'char', char: c }) as const;
const ctrl = (c: string) => ({ type: 'ctrl', char: c }) as const;

function apply(panel: TaskPanel, ...events: TaskEvent[]): TaskPanel {
  return events.reduce(applyTaskEvent, panel);
}
function press(panel: TaskPanel, ...events: InputEvent[]): { panel: TaskPanel; commands: unknown[] } {
  const commands: unknown[] = [];
  for (const event of events) {
    const out = taskKey(panel, event, { rows: 10, total: panel.lines.length });
    panel = out.panel;
    if (out.command) commands.push(out.command);
  }
  return { panel, commands };
}
const running = (): TaskPanel => apply(openTaskPanel('status', 'Show status'), { kind: 'started' });
const lines = (n: number): TaskEvent[] => Array.from({ length: n }, (_, i) => ({ kind: 'line', text: `line ${i + 1}`, tone: 'out' }));

describe('taskKey', () => {
  it('answers a yes/no question with y, n, Enter (the default) and Esc or Ctrl-C (no), echoing the answer', () => {
    const asking = (defaultYes: boolean) => apply(running(), { kind: 'prompt', prompt: { kind: 'confirm', question: 'Update now?', defaultYes } });
    expect(press(asking(false), char('y')).commands).toEqual([{ task: 'answer', value: true }]);
    expect(press(asking(true), char('n')).commands).toEqual([{ task: 'answer', value: false }]);
    expect(press(asking(true), key('enter')).commands).toEqual([{ task: 'answer', value: true }]);
    expect(press(asking(false), key('enter')).commands).toEqual([{ task: 'answer', value: false }]);
    expect(press(asking(true), key('escape')).commands).toEqual([{ task: 'answer', value: false }]);
    expect(press(asking(true), ctrl('c')).commands).toEqual([{ task: 'answer', value: false }]);
    const done = press(asking(true), char('x'), char('y'));
    expect(done.commands).toEqual([{ task: 'answer', value: true }]);
    expect(done.panel.prompt).toBeNull();
    expect(done.panel.lines.at(-1)).toEqual({ text: 'Update now? Yes', tone: 'input' });
  });

  it('edits a line of text: typing and pasting at the cursor, backspace, arrows, Ctrl-U, Enter and Esc', () => {
    const asking = apply(running(), { kind: 'prompt', prompt: { kind: 'text', question: 'Path:' } });
    let { panel } = press(asking, ...[...'/tmp/b.csv'].map(char), key('home'), key('right'), key('right'));
    panel = press(panel, key('backspace'), char('T')).panel;
    expect(panel.prompt).toMatchObject({ value: '/Tmp/b.csv', cursor: 2 });
    panel = press(panel, key('end'), key('left'), key('left'), key('left'), key('backspace')).panel;
    expect(panel.prompt).toMatchObject({ value: '/Tmp/bcsv' });
    const sent = press(panel, key('enter'));
    expect(sent.commands).toEqual([{ task: 'answer', value: '/Tmp/bcsv' }]);
    expect(sent.panel.lines.at(-1)!.text).toBe('Path: /Tmp/bcsv');
    expect(press(panel, ctrl('u')).panel.prompt).toMatchObject({ value: 'csv', cursor: 0 });
    expect(press(panel, key('escape')).commands).toEqual([{ task: 'answer', value: '' }]);
    expect(press(asking, char(' '), char(' '), key('enter')).commands).toEqual([{ task: 'answer', value: '' }]);
  });

  it('picks from a list with the arrows, a digit or Enter; Esc cancels with null', () => {
    const asking = apply(running(), { kind: 'prompt', prompt: { kind: 'choice', question: 'Account?', choices: ['a', 'b', 'c'], defaultIndex: 1 } });
    expect(asking.prompt).toMatchObject({ selected: 1 });
    expect(press(asking, key('down'), key('down'), key('enter')).commands).toEqual([{ task: 'answer', value: 2 }]);
    expect(press(asking, key('up'), key('up'), key('enter')).commands).toEqual([{ task: 'answer', value: 0 }]);
    expect(press(asking, char('3')).commands).toEqual([{ task: 'answer', value: 2 }]);
    expect(press(asking, char('9')).commands).toEqual([]);
    expect(press(asking, key('escape')).commands).toEqual([{ task: 'answer', value: null }]);
  });

  it('stops a command only when it can stop; otherwise Esc only says so and Ctrl-C arms a quit', () => {
    const esc = press(running(), key('escape'));
    expect(esc.commands).toEqual([]);
    expect(esc.panel.busyHint).toBe('esc');
    const stoppable = apply(running(), { kind: 'cancellable', value: true });
    const cancelled = press(stoppable, key('escape'), key('escape'));
    expect(cancelled.commands).toEqual([{ task: 'cancel' }]);
    expect(cancelled.panel).toMatchObject({ cancelling: true, busyHint: null });
    // A command that can no longer stop is not being cancelled any more.
    expect(apply(cancelled.panel, { kind: 'cancellable', value: false })).toMatchObject({ cancelling: false, cancellable: false });
  });

  it('quits tokengraph on a second Ctrl-C within two seconds while a command that cannot stop runs', () => {
    const first = taskKey(running(), ctrl('c'), null, 1000);
    expect(first.command).toBeNull();
    expect(first.panel).toMatchObject({ busyHint: 'quit', quitArmedAt: 1000 });
    expect(taskKey(first.panel, ctrl('c'), null, 2900).command).toEqual({ task: 'quit' });
    // Too late: it arms again instead.
    const late = taskKey(first.panel, ctrl('c'), null, 3500);
    expect(late.command).toBeNull();
    expect(late.panel.quitArmedAt).toBe(3500);
    // Esc never quits, and without a clock nothing quits.
    expect(taskKey(first.panel, key('escape'), null, 1500).command).toBeNull();
    expect(taskKey(taskKey(running(), ctrl('c'), null).panel, ctrl('c'), null).command).toBeNull();
    // A cancellable command is cancelled by the first Ctrl-C; once cancelling, a hung cancel can still be left.
    const stoppable = apply(running(), { kind: 'cancellable', value: true });
    const cancelling = taskKey(stoppable, ctrl('c'), null, 0);
    expect(cancelling.command).toEqual({ task: 'cancel' });
    const armed = taskKey(cancelling.panel, ctrl('c'), null, 100);
    expect(taskKey(armed.panel, ctrl('c'), null, 200).command).toEqual({ task: 'quit' });
  });

  it('closes a box still waiting for the scan on Esc or Ctrl-C: nothing has run yet', () => {
    const waiting = openTaskPanel('status', 'Show status');
    expect(taskKey(waiting, key('escape'), null).command).toEqual({ task: 'close', after: 'reload' });
    expect(taskKey(waiting, ctrl('c'), null).command).toEqual({ task: 'close', after: 'reload' });
    expect(taskKey(waiting, char('q'), null).command).toBeNull();
  });

  it('ignores an answer typed ahead for the previous question, but not Esc or editing', () => {
    const asking = applyTaskEvent(running(), { kind: 'prompt', prompt: { kind: 'confirm', question: 'Delete?', defaultYes: true } }, 1000);
    expect(taskKey(asking, key('enter'), null, 1100).command).toBeNull();
    expect(taskKey(asking, char('y'), null, 1100).command).toBeNull();
    expect(taskKey(asking, key('enter'), null, 1150).command).toEqual({ task: 'answer', value: true });
    expect(taskKey(asking, key('escape'), null, 1010).command).toEqual({ task: 'answer', value: false });
    const path = applyTaskEvent(running(), { kind: 'prompt', prompt: { kind: 'text', question: 'Path:' } }, 1000);
    expect(taskKey(path, key('enter'), null, 1050).command).toBeNull();
    expect(taskKey(path, char('a'), null, 1050).panel.prompt).toMatchObject({ value: 'a' });
    const list = applyTaskEvent(running(), { kind: 'prompt', prompt: { kind: 'choice', question: 'Which?', choices: ['a', 'b'], defaultIndex: 0 } }, 1000);
    expect(taskKey(list, char('2'), null, 1100).command).toBeNull();
    expect(taskKey(list, char('2'), null, 1200).command).toEqual({ task: 'answer', value: 1 });
  });

  it('keeps control characters out of a typed or pasted line', () => {
    const asking = apply(running(), { kind: 'prompt', prompt: { kind: 'text', question: 'Path:' } });
    const typed = press(asking, char('a'), char('\t'), char('\x1b'), char('b')).panel;
    expect(typed.prompt).toMatchObject({ value: 'ab', cursor: 2 });
  });

  it('closes a finished box on Enter, Esc or Ctrl-C, saying what closing leads to', () => {
    const done = apply(running(), { kind: 'done', code: 0, after: 'reload', cancelled: false });
    expect(press(done, char('q')).commands).toEqual([]);
    expect(press(done, key('enter')).commands).toEqual([{ task: 'close', after: 'reload' }]);
    expect(press(done, ctrl('c')).commands).toEqual([{ task: 'close', after: 'reload' }]);
    const updated = apply(running(), { kind: 'done', code: 0, after: 'restart', cancelled: false });
    expect(press(updated, key('escape')).commands).toEqual([{ task: 'close', after: 'restart' }]);
  });

  it('scrolls: up leaves the tail, End and the bottom follow again, Home and PgUp jump', () => {
    const full = apply(running(), ...lines(30));
    const view = { rows: 10, total: 30 };
    let panel = taskKey(full, key('up'), view).panel;
    expect(panel).toMatchObject({ follow: false, scroll: 19 });
    panel = taskKey(panel, key('pageup'), view).panel;
    expect(panel.scroll).toBe(10);
    panel = taskKey(panel, key('home'), view).panel;
    expect(panel).toMatchObject({ follow: false, scroll: 0 });
    panel = taskKey(panel, key('up'), view).panel;
    expect(panel.scroll).toBe(0);
    for (let i = 0; i < 3; i += 1) panel = taskKey(panel, key('pagedown'), view).panel;
    expect(panel.follow).toBe(true);
    panel = taskKey(taskKey(panel, key('home'), view).panel, key('end'), view).panel;
    expect(panel.follow).toBe(true);
    panel = taskKey(full, { type: 'mouse', action: 'wheelup', x: 0, y: 0, button: 64 }, view).panel;
    expect(panel.scroll).toBe(17);
    // Output that fits never leaves the tail.
    expect(taskKey(full, key('up'), { rows: 40, total: 30 }).panel.follow).toBe(true);
  });
});

describe('applyTaskEvent', () => {
  it('collects output, keeps the spinner text and the end', () => {
    const panel = apply(
      openTaskPanel('sync', 'Sync now'),
      { kind: 'started' },
      { kind: 'line', text: 'Reading…', tone: 'out' },
      { kind: 'spinner', text: 'Reading Codex…' },
    );
    expect(panel).toMatchObject({ started: true, spinner: 'Reading Codex…', status: 'running', lines: [{ text: 'Reading…', tone: 'out' }] });
    const failed = apply(panel, { kind: 'done', code: 2, after: 'reload', cancelled: false });
    expect(failed).toMatchObject({ status: 'failed', code: 2, spinner: null, prompt: null });
    expect(apply(panel, { kind: 'done', code: 0, after: 'quit', cancelled: false })).toMatchObject({ status: 'done', after: 'quit' });
  });

  it('keeps the newest MAX_LINES lines, and drops none under a scrolled view until MAX_LINES_SCROLLED', () => {
    const following = apply(running(), ...lines(MAX_LINES + 5));
    expect(following.lines).toHaveLength(MAX_LINES);
    expect(following.lines[0]!.text).toBe('line 6');
    // Scrolled up: the rows on screen must not move, so nothing above them is dropped.
    let panel: TaskPanel = { ...apply(running(), ...lines(MAX_LINES)), follow: false, scroll: 100 };
    panel = apply(panel, ...lines(5));
    expect(panel.lines).toHaveLength(MAX_LINES + 5);
    expect(panel).toMatchObject({ follow: false, scroll: 100 });
    // Past the higher limit the oldest go after all, and the box returns to the newest output.
    panel = apply(panel, ...lines(MAX_LINES_SCROLLED - MAX_LINES));
    expect(panel.lines).toHaveLength(MAX_LINES);
    expect(panel.follow).toBe(true);
  });

  it('brings a question into view', () => {
    const scrolled = { ...apply(running(), ...lines(30)), follow: false, scroll: 0 };
    expect(apply(scrolled, { kind: 'prompt', prompt: { kind: 'text', question: 'Path:' } })).toMatchObject({ follow: true, prompt: { kind: 'text', value: '' } });
  });
});

describe('the task box', () => {
  const theme = tuiTheme('dark');
  const draw = (panel: TaskPanel, width = 100, height = 30) => {
    const buf = new ScreenBuffer(width, height);
    const viewport = drawTask(buf, { x: 0, y: 0, width, height }, panel, theme, 0);
    return { text: toPlainText(buf), viewport };
  };

  it('wraps keeping the indentation and breaks long words instead of cutting them', () => {
    expect(wrapText('  one two three four', 12)).toEqual(['  one two', '  three four']);
    const url = 'https://gist.github.com/octocat/0123456789abcdef0123456789';
    expect(wrapText(url, 20).join('')).toBe(url);
    expect(wrapText('', 10)).toEqual(['']);
  });

  it('drops leading blank lines and keeps runs of blank lines to one', () => {
    const tidy = tidyLines([{ text: '', tone: 'out' }, { text: 'a', tone: 'out' }, { text: '  ', tone: 'out' }, { text: '', tone: 'out' }, { text: 'b', tone: 'out' }]);
    expect(tidy.map((line) => line.text)).toEqual(['a', '', 'b']);
  });

  it('shows the title, the newest output, the busy line and the cancel key while it runs', () => {
    const panel = apply(running(), ...lines(60), { kind: 'spinner', text: 'Reading Codex…' }, { kind: 'cancellable', value: true });
    const { text, viewport } = draw(panel);
    expect(text).toContain('SHOW STATUS');
    expect(text).toContain('line 60');
    expect(text).not.toMatch(/line 1\s/);
    expect(text).toContain('Reading Codex…');
    expect(text).toContain('esc cancel');
    expect(text).toContain('↑↓ scroll');
    expect(viewport.total).toBe(60);
    expect(viewport.rows).toBeGreaterThan(10);
    expect(draw(openTaskPanel('status', 'Show status')).text).toContain('Waiting for the scan to finish…');
  });

  it('shows how many lines sit above and below a scrolled view', () => {
    const panel = { ...apply(running(), ...lines(60)), follow: false, scroll: 5 };
    const { text } = draw(panel);
    expect(text).toContain('↑ 5 more');
    expect(text).toMatch(/↓ \d+ more/);
    expect(text).toMatch(/line 6\s/);
  });

  it('shows a text question with its typed line, and a list with the picked choice', () => {
    let panel = apply(running(), { kind: 'prompt', prompt: { kind: 'text', question: 'Path to the Cursor usage CSV (empty to cancel):' } });
    panel = press(panel, ...[...'~/Downloads/usage.csv'].map(char)).panel;
    const text = draw(panel).text;
    expect(text).toContain('Path to the Cursor usage CSV (empty to cancel):');
    expect(text).toContain('› ~/Downloads/usage.csv');
    expect(text).toContain('enter ok  esc cancel');
    const listed = apply(running(), { kind: 'prompt', prompt: { kind: 'choice', question: 'Account?', choices: ['work', 'home'], defaultIndex: 1 } });
    expect(draw(listed).text).toMatch(/▸ 2\) home/);
  });

  it('shows a cancelled run as a neutral end, and the hints for a command that cannot stop', () => {
    const cancelled = draw(apply(running(), { kind: 'done', code: 1, after: 'reload', cancelled: true })).text;
    expect(cancelled).toContain('– Cancelled');
    expect(cancelled).not.toContain('Failed');
    expect(draw(press(running(), key('escape')).panel).text).toContain('You can close the box once it is done.');
    expect(draw(taskKey(running(), ctrl('c'), null, 0).panel).text).toContain('Press Ctrl-C again to quit tokengraph.');
    expect(draw(openTaskPanel('status', 'Show status')).text).toContain('esc close');
  });

  it('keeps the border in line with wide and combining characters in the output and the typed line', () => {
    expect(charWidth('名')).toBe(2);
    expect(charWidth('\u0301')).toBe(0);
    expect(charWidth('a')).toBe(1);
    expect(displayWidth('名前a')).toBe(5);
    expect(narrow('名前 e\u0301')).toBe('?? é');
    const wide = '名前'.repeat(80);
    let panel = apply(running(), { kind: 'line', text: wide, tone: 'out' }, { kind: 'line', text: 'cafe\u0301 ✓', tone: 'out' });
    panel = apply(panel, { kind: 'prompt', prompt: { kind: 'text', question: 'Path:' } });
    panel = press(panel, ...[...'/tmp/写真/x\u0301.csv'].map(char)).panel;
    expect(panel.prompt).toMatchObject({ value: '/tmp/写真/x\u0301.csv' });
    const { text } = draw(panel, 100, 30);
    const rows = text.split('\n');
    const right = rows.filter((r) => r.includes('│')).map((r) => r.lastIndexOf('│'));
    expect(new Set(right).size).toBe(1);
    expect(text).toContain('› /tmp/??/x·.csv');
  });

  it('ends with Done or Failed and the key that closes it', () => {
    expect(draw(apply(running(), { kind: 'done', code: 0, after: 'reload', cancelled: false })).text).toMatch(/✓ Done[\s\S]*enter close/);
    expect(draw(apply(running(), { kind: 'done', code: 1, after: 'reload', cancelled: false })).text).toContain('✗ Failed (exit code 1)');
    expect(draw(apply(running(), { kind: 'done', code: 0, after: 'quit', cancelled: false })).text).toContain('enter quit tokengraph');
  });

  it('fits the smallest supported window', () => {
    const panel = apply(running(), ...lines(200), { kind: 'prompt', prompt: { kind: 'confirm', question: 'Also delete your tokengraph data?', defaultYes: false } });
    const { text } = draw(panel, 80, 24);
    expect(text).toContain('Also delete your tokengraph data?  [y/N]');
    expect(text).toContain('y yes  n no  esc cancel');
    expect(text).toContain('line 200');
  });
});
