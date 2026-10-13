import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendCursorEvent,
  cursorEventsPath,
  eventFromHookPayload,
  parseCursorEvent,
} from '../src/adapters/cursor/events.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');

const PAYLOAD = {
  hook_event_name: 'stop',
  conversation_id: 'conv-1',
  generation_id: 'gen-1',
  model: 'composer-2.5',
  model_id: 'composer-2.5',
  model_params: [{ id: 'fast', value: 'true' }],
  status: 'completed',
  loop_count: 0,
  cursor_version: '3.14.7',
  workspace_roots: ['/secret/project'],
  user_email: 'someone@example.com',
  transcript_path: '/secret/transcript.jsonl',
  text: 'the assistant answer',
  input_tokens: 1180993,
  output_tokens: 8146,
  cache_read_tokens: 1007022,
  cache_write_tokens: 173957,
};

describe('eventFromHookPayload', () => {
  it('keeps only the allowed fields and stamps the receive time', () => {
    expect(eventFromHookPayload(PAYLOAD, NOW)).toEqual({
      v: 1,
      receivedAt: '2026-09-24T12:00:00.000Z',
      generationId: 'gen-1',
      model: 'composer-2.5',
      modelId: 'composer-2.5',
      fast: true,
      status: 'completed',
      cursorVersion: '3.14.7',
      inputTokens: 1180993,
      outputTokens: 8146,
      cacheReadTokens: 1007022,
      cacheWriteTokens: 173957,
    });
  });

  it('never keeps text, paths, e-mail, workspace roots or the conversation id', () => {
    const serialised = JSON.stringify(eventFromHookPayload(PAYLOAD, NOW));
    for (const secret of ['the assistant answer', '/secret/', 'someone@example.com', 'conv-1']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('keeps missing token fields as null, not zero', () => {
    const { input_tokens: _i, output_tokens: _o, cache_read_tokens: _r, cache_write_tokens: _w, ...noTokens } = PAYLOAD;
    const event = eventFromHookPayload(noTokens, NOW)!;
    expect(event.inputTokens).toBeNull();
    expect(event.outputTokens).toBeNull();
    expect(event.cacheReadTokens).toBeNull();
    expect(event.cacheWriteTokens).toBeNull();
  });

  it('reads the fast flag from model_params as a boolean or a string, and defaults to false', () => {
    expect(eventFromHookPayload({ ...PAYLOAD, model_params: [{ id: 'fast', value: true }] }, NOW)!.fast).toBe(true);
    expect(eventFromHookPayload({ ...PAYLOAD, model_params: [{ id: 'fast', value: 'false' }] }, NOW)!.fast).toBe(false);
    const { model_params: _p, ...noParams } = PAYLOAD;
    expect(eventFromHookPayload(noParams, NOW)!.fast).toBe(false);
  });

  it('also reads the fast flag when the param uses `name` instead of `id`', () => {
    expect(eventFromHookPayload({ ...PAYLOAD, model_params: [{ name: 'fast', value: true }] }, NOW)!.fast).toBe(true);
  });

  it('rejects negative or non-numeric token values as null', () => {
    const event = eventFromHookPayload({ ...PAYLOAD, input_tokens: -1, output_tokens: 'lots' }, NOW)!;
    expect(event.inputTokens).toBeNull();
    expect(event.outputTokens).toBeNull();
  });

  it('ignores other hook events and payloads without a generation id', () => {
    expect(eventFromHookPayload({ ...PAYLOAD, hook_event_name: 'afterAgentResponse' }, NOW)).toBeNull();
    expect(eventFromHookPayload({ ...PAYLOAD, generation_id: '' }, NOW)).toBeNull();
    expect(eventFromHookPayload('not an object', NOW)).toBeNull();
    expect(eventFromHookPayload(null, NOW)).toBeNull();
  });

  it('truncates over-long model, model id, status and cursor version strings to 200 characters', () => {
    const long = 'x'.repeat(250);
    const event = eventFromHookPayload(
      { ...PAYLOAD, model: long, model_id: long, status: long, cursor_version: long },
      NOW,
    )!;
    expect(event.model).toBe('x'.repeat(200));
    expect(event.modelId).toBe('x'.repeat(200));
    expect(event.status).toBe('x'.repeat(200));
    expect(event.cursorVersion).toBe('x'.repeat(200));
  });

  it('rejects a generation id longer than 200 characters', () => {
    expect(eventFromHookPayload({ ...PAYLOAD, generation_id: 'g'.repeat(201) }, NOW)).toBeNull();
  });
});

describe('parseCursorEvent', () => {
  it('round-trips an event line', () => {
    const event = eventFromHookPayload(PAYLOAD, NOW)!;
    expect(parseCursorEvent(JSON.stringify(event))).toEqual(event);
  });

  it('rejects malformed lines, unknown versions, missing ids and bad timestamps', () => {
    const event = eventFromHookPayload(PAYLOAD, NOW)!;
    expect(parseCursorEvent('not json')).toBeNull();
    expect(parseCursorEvent('')).toBeNull();
    expect(parseCursorEvent(JSON.stringify({ ...event, v: 2 }))).toBeNull();
    expect(parseCursorEvent(JSON.stringify({ ...event, generationId: '' }))).toBeNull();
    expect(parseCursorEvent(JSON.stringify({ ...event, receivedAt: 'yesterday' }))).toBeNull();
  });

  it('rejects a line without a boolean fast field', () => {
    const { fast: _fast, ...rest } = eventFromHookPayload(PAYLOAD, NOW)!;
    expect(parseCursorEvent(JSON.stringify(rest))).toBeNull();
    expect(parseCursorEvent(JSON.stringify({ ...rest, fast: 'true' }))).toBeNull();
  });

  it('rejects a wrong-typed nullable field', () => {
    const event = eventFromHookPayload(PAYLOAD, NOW)!;
    expect(parseCursorEvent(JSON.stringify({ ...event, inputTokens: '10' }))).toBeNull();
  });
});

describe('appendCursorEvent', () => {
  const saved = process.env['TOKENGRAPH_HOME'];
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tg-cursor-'));
    process.env['TOKENGRAPH_HOME'] = join(home, 'tg');
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
    await rm(home, { recursive: true, force: true });
  });

  it('appends one private JSON line per event under TOKENGRAPH_HOME', async () => {
    const event = eventFromHookPayload(PAYLOAD, NOW)!;
    await appendCursorEvent(event);
    await appendCursorEvent({ ...event, generationId: 'gen-2' });
    expect(cursorEventsPath()).toBe(join(home, 'tg', 'cursor-events.jsonl'));
    const lines = (await readFile(cursorEventsPath(), 'utf8')).trim().split('\n');
    expect(lines.map((l) => parseCursorEvent(l)!.generationId)).toEqual(['gen-1', 'gen-2']);
    // Windows has no POSIX file modes, so this bit is only meaningful on POSIX platforms.
    if (process.platform !== 'win32') expect((await stat(cursorEventsPath())).mode & 0o777).toBe(0o600);
  });
});
