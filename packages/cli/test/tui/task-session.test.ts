import { afterEach, describe, expect, it, vi } from 'vitest';
import { askChoice, askText, askYesNo } from '../../src/prompt.js';
import { commandSpinner } from '../../src/spinner.js';
import { cleanLine, startTaskSession, type TaskEvent, type TaskRun } from '../../src/tui/task-session.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function record(run: TaskRun) {
  const events: TaskEvent[] = [];
  const session = startTaskSession(run, (event) => void events.push(event));
  const done = async () => {
    for (let i = 0; i < 50 && !events.some((event) => event.kind === 'done'); i += 1) await tick();
  };
  return { events, session, done };
}

afterEach(() => vi.restoreAllMocks());

describe('cleanLine', () => {
  it('keeps the last redraw of a line and drops colours, cursor moves, links and control characters', () => {
    expect(cleanLine('\x1b[1mbold\x1b[22m and \x1b[31mred\x1b[0m')).toBe('bold and red');
    expect(cleanLine('fetching 10%\rfetching 100%\r')).toBe('fetching 100%');
    expect(cleanLine('\x1b]8;;https://x.test\x07link\x1b]8;;\x07\x1b[2K')).toBe('link');
    expect(cleanLine('a\tb\x07\x00c  ')).toBe('a    bc');
    expect(cleanLine('a ⭐ on GitHub 🎉')).toBe('a ★ on GitHub *');
    // Wide characters get a one-column stand-in and combining marks fold in or go, so the box border stays put.
    expect(cleanLine('名前 cafe\u0301 x\u0308\u200d')).toBe('?? café ẍ');
    expect(cleanLine('✓ Logged in')).toBe('✓ Logged in');
  });
});

describe('startTaskSession', () => {
  it('streams console output line by line as it is printed, not at the end', async () => {
    let release: () => void = () => {};
    const { events, done } = record(async () => {
      console.log('first\nsecond');
      await new Promise<void>((resolve) => { release = resolve; });
      console.error('\x1b[31mlast\x1b[0m', 2);
      return { code: 0 };
    });
    await tick();
    expect(events).toEqual([
      { kind: 'started' },
      { kind: 'line', text: 'first', tone: 'out' },
      { kind: 'line', text: 'second', tone: 'out' },
    ]);
    release();
    await done();
    expect(events.slice(3)).toEqual([{ kind: 'line', text: 'last 2', tone: 'err' }, { kind: 'done', code: 0, after: 'reload', cancelled: false }]);
  });

  it('routes every prompt to the box and puts the console and the prompts back afterwards', async () => {
    const log = console.log;
    const answers: unknown[] = [];
    const { events, session, done } = record(async () => {
      answers.push(await askYesNo('\nKeep your graph updated every hour?'));
      answers.push(await askText('Path:'));
      answers.push(await askChoice('Which?', ['a', 'b'], { defaultIndex: 1 }));
      return { code: 0, after: 'quit' };
    });
    await tick();
    expect(events.at(-1)).toEqual({ kind: 'prompt', prompt: { kind: 'confirm', question: 'Keep your graph updated every hour?', defaultYes: true } });
    session.answer(true);
    await tick();
    expect(events.at(-1)).toEqual({ kind: 'prompt', prompt: { kind: 'text', question: 'Path:' } });
    session.answer('  ~/usage.csv ');
    await tick();
    expect(events.at(-1)).toEqual({ kind: 'prompt', prompt: { kind: 'choice', question: 'Which?', choices: ['a', 'b'], defaultIndex: 1 } });
    session.answer(0);
    await done();
    expect(answers).toEqual([true, '~/usage.csv', 0]);
    expect(events.at(-1)).toEqual({ kind: 'done', code: 0, after: 'quit', cancelled: false });
    expect(console.log).toBe(log);
    // Back on the terminal (none under vitest), a prompt returns its default at once instead of waiting on the box.
    expect(await askYesNo('Again?', { defaultYes: false })).toBe(false);
  });

  it("feeds a sync's spinner to the box's busy line, and a plain spinner draws on its stream again afterwards", async () => {
    const stream = { write: vi.fn(() => true) };
    const { events, done } = record(async () => {
      const spinner = commandSpinner(stream, { enabled: true });
      spinner.start('\x1b[2mReading Codex…\x1b[22m');
      spinner.clear();
      spinner.stop();
      return { code: 0 };
    });
    await done();
    expect(events.filter((event) => event.kind === 'spinner')).toEqual([{ kind: 'spinner', text: 'Reading Codex…' }, { kind: 'spinner', text: null }]);
    expect(stream.write).not.toHaveBeenCalled();
    const after = commandSpinner(stream, { enabled: true });
    after.start('x');
    after.stop();
    expect(stream.write).toHaveBeenCalled();
  });

  it('turns a throw into a failed run with the message as its last line', async () => {
    const { events, done } = record(async () => {
      throw new Error('boom');
    });
    await done();
    expect(events.slice(-2)).toEqual([{ kind: 'line', text: 'boom', tone: 'err' }, { kind: 'done', code: 1, after: 'reload', cancelled: false }]);
  });

  it('aborts the signal on cancel and reports when the command can stop', async () => {
    const { events, session, done } = record(async (context) => {
      context.cancellable(true);
      context.busy('Waiting for GitHub…');
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()));
      context.busy(null);
      context.cancellable(false);
      context.print('child \x1b[32moutput\x1b[0m');
      return { code: 1 };
    });
    await tick();
    expect(events).toContainEqual({ kind: 'cancellable', value: true });
    expect(events).toContainEqual({ kind: 'spinner', text: 'Waiting for GitHub…' });
    session.cancel();
    await done();
    expect(events).toContainEqual({ kind: 'line', text: 'child output', tone: 'out' });
    // Stopped as asked: an end of its own, not a failure.
    expect(events.at(-1)).toEqual({ kind: 'done', code: 1, after: 'reload', cancelled: true });
  });

  it('reports a cancel the command ignored by succeeding as done, not cancelled', async () => {
    const { events, session, done } = record(async (context) => {
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()));
      return { code: 0 };
    });
    await tick();
    session.cancel();
    await done();
    expect(events.at(-1)).toEqual({ kind: 'done', code: 0, after: 'reload', cancelled: false });
  });

  it('stop settles an open question as cancelled, restores everything and sends nothing more', async () => {
    const log = console.log;
    let answer: unknown = 'unset';
    const { events, session } = record(async (context) => {
      answer = await askText('Path:');
      context.print('after the stop');
      return { code: 0 };
    });
    await tick();
    const seen = events.length;
    session.stop();
    await tick();
    await tick();
    expect(answer).toBe('');
    expect(events).toHaveLength(seen);
    expect(console.log).toBe(log);
  });

  it('never writes to stdout or stderr itself', async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const { done } = record(async () => {
      console.log('out');
      console.warn('warn');
      console.info('info');
      console.debug('debug');
      return { code: 0 };
    });
    await done();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
