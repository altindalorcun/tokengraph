import { mkdtemp, readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cursorEventsPath, parseCursorEvent } from '../src/adapters/cursor/events.js';
import { readStdinWithTimeout, runCursorHook } from '../src/commands/cursor-hook.js';

const PAYLOAD = JSON.stringify({
  hook_event_name: 'stop',
  generation_id: 'gen-1',
  model: 'composer-2.5',
  status: 'completed',
  input_tokens: 100,
  output_tokens: 10,
  cache_read_tokens: 50,
  cache_write_tokens: 5,
});

describe('runCursorHook', () => {
  const saved = process.env['TOKENGRAPH_HOME'];
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-hook-'));
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
    await rm(root, { recursive: true, force: true });
  });

  function deps(stdin: string, now = new Date('2026-09-24T12:00:00.000Z')) {
    const out: string[] = [];
    return {
      out,
      deps: { now: () => now, readStdin: async () => stdin, writeStdout: (t: string) => out.push(t) },
    };
  }

  it('records the event and prints {}', async () => {
    const d = deps(PAYLOAD);
    expect(await runCursorHook(d.deps)).toBe(0);
    expect(d.out.join('')).toBe('{}');
    const [line] = (await readFile(cursorEventsPath(), 'utf8')).trim().split('\n');
    expect(parseCursorEvent(line!)).toMatchObject({ generationId: 'gen-1', inputTokens: 100 });
  });

  it('records the turn without writing a sync stamp file or spawning a sync', async () => {
    const d = deps(PAYLOAD);
    expect(await runCursorHook(d.deps)).toBe(0);
    expect(d.out.join('')).toBe('{}');
    const entries = await readFile(cursorEventsPath(), 'utf8');
    expect(entries.trim().split('\n')).toHaveLength(1);
    await expect(readFile(join(root, 'tg', 'cursor-sync.stamp'), 'utf8')).rejects.toThrow();
  });

  it('prints {} and exits 0 on empty or malformed stdin without recording', async () => {
    for (const stdin of ['', 'not json', JSON.stringify({ hook_event_name: 'stop' })]) {
      const d = deps(stdin);
      expect(await runCursorHook(d.deps)).toBe(0);
      expect(d.out.join('')).toBe('{}');
    }
    await expect(readFile(cursorEventsPath(), 'utf8')).rejects.toThrow();
  });

  it('still prints {} and exits 0 when the events file cannot be written', async () => {
    await mkdir(join(root, 'tg'), { recursive: true });
    await writeFile(cursorEventsPath(), '');
    await chmod(cursorEventsPath(), 0o400);
    const d = deps(PAYLOAD);
    expect(await runCursorHook(d.deps)).toBe(0);
    expect(d.out.join('')).toBe('{}');
  });
});

describe('readStdinWithTimeout', () => {
  it('resolves with whatever arrived once the stream ends before the timeout', async () => {
    const stream = new PassThrough();
    const promise = readStdinWithTimeout(stream, 5000);
    stream.end('hello');
    expect(await promise).toBe('hello');
  });

  it('resolves with the partial data collected so far when the stream never ends', async () => {
    const stream = new PassThrough();
    const promise = readStdinWithTimeout(stream, 20);
    stream.write('partial-data');
    expect(await promise).toBe('partial-data');
  });

  it('resolves empty when nothing arrives before the timeout', async () => {
    const stream = new PassThrough();
    expect(await readStdinWithTimeout(stream, 20)).toBe('');
  });

  it('resolves immediately without waiting when the stream is a TTY', async () => {
    const stream = Object.assign(new PassThrough(), { isTTY: true });
    const start = Date.now();
    expect(await readStdinWithTimeout(stream, 5000)).toBe('');
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('resolves as soon as a complete JSON object has arrived, without waiting for end or timeout', async () => {
    const stream = new PassThrough();
    const payload = JSON.stringify({ hook_event_name: 'stop', generation_id: 'gen-1' });
    const start = Date.now();
    const promise = readStdinWithTimeout(stream, 3000);
    stream.write(payload);
    expect(await promise).toBe(payload);
    expect(Date.now() - start).toBeLessThan(500);
    // The stream is never ended — proves the resolution did not wait on 'end'.
  });

  it('does not throw when the stream errors after settling on a parsed payload', async () => {
    const stream = new PassThrough();
    const payload = JSON.stringify({ hook_event_name: 'stop' });
    const promise = readStdinWithTimeout(stream, 3000);
    stream.write(payload);
    await promise;
    expect(() => stream.emit('error', new Error('late pipe error'))).not.toThrow();
  });
});
