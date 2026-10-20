import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));

async function start(extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-llm-'));
  const logFile = join(dir, 'log.jsonl');
  const child = spawn(process.execPath, [SCRIPT, '--port', '0', '--log', logFile, ...extraArgs], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /READY (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', () => reject(new Error('server exited early')));
  });
  const base = `http://127.0.0.1:${port}`;
  const lines = () =>
    readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { base, lines, stop, child };
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Parse an SSE body into [{event, data}] (data parsed as JSON unless [DONE]). */
function sse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const ev = /^event: (.*)$/m.exec(block)?.[1] ?? null;
    const raw = /^data: (.*)$/m.exec(block)?.[1];
    return { event: ev, data: raw === '[DONE]' ? raw : JSON.parse(raw) };
  });
}

const READ_TOOL = { name: 'read_file', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const WRITE_TOOL = { name: 'write_file', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };

describe('fake-llm', () => {
  let s;
  beforeAll(async () => { s = await start(); });
  afterAll(async () => { await s.stop(); });

  it('anthropic non-streaming and streaming, with a path prefix', async () => {
    const r = await post(`${s.base}/anthropic/v1/messages`, { model: 'm-a', messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'anything' });
    const j = await r.json();
    expect(j.type).toBe('message');
    expect(j.usage.input_tokens).toBeGreaterThan(0);
    expect(j.usage.cache_creation.ephemeral_5m_input_tokens + j.usage.cache_creation.ephemeral_1h_input_tokens).toBe(j.usage.cache_creation_input_tokens);

    const r2 = await post(`${s.base}/v1/messages`, { model: 'm-a', stream: true, messages: [] });
    const ev = sse(await r2.text());
    expect(ev.map((e) => e.event)).toEqual(['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const start = ev[0].data.message.usage;
    const delta = ev[6].data.usage;
    const last = s.lines().at(-1);
    expect(last).toMatchObject({ protocol: 'anthropic', model: 'm-a', stream: true, responseId: ev[0].data.message.id });
    expect(last.normalized).toEqual({ input: start.input_tokens, output: delta.output_tokens, cacheRead: start.cache_read_input_tokens, cacheWrite: start.cache_creation_input_tokens });
    expect(start.cache_creation).toBeDefined();
  });

  it('count_tokens', async () => {
    const r = await post(`${s.base}/v1/messages/count_tokens`, { model: 'm-a', messages: [] });
    expect(await r.json()).toHaveProperty('input_tokens');
  });

  it('openai chat: usage only when requested', async () => {
    const without = sse(await (await post(`${s.base}/v1/chat/completions`, { model: 'm-c', stream: true, messages: [] })).text());
    expect(without.at(-1).data).toBe('[DONE]');
    expect(without.some((e) => e.data?.usage)).toBe(false);
    expect(s.lines().at(-1).usage).toBeNull();

    const withU = sse(await (await post(`${s.base}/chat/completions`, { model: 'm-c', stream: true, stream_options: { include_usage: true }, messages: [] })).text());
    const usageChunk = withU.find((e) => e.data?.usage).data;
    const u = usageChunk.usage;
    expect(u.total_tokens).toBe(u.prompt_tokens + u.completion_tokens);
    const last = s.lines().at(-1);
    expect(last.usage).toEqual(u);
    expect(last.normalized.input).toBe(u.prompt_tokens - u.prompt_tokens_details.cached_tokens);
    expect(last.normalized.cacheRead).toBe(u.prompt_tokens_details.cached_tokens);
    expect(u.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);

    const ns = await (await post(`${s.base}/v1/chat/completions`, { model: 'm-c', messages: [] })).json();
    expect(ns.choices[0].message.content).toMatch(/^ok \d+$/);
    expect(ns.usage.prompt_tokens_details.cached_tokens).toBeGreaterThan(0);
  });

  it('openai responses streaming and non-streaming', async () => {
    const ev = sse(await (await post(`${s.base}/v1/responses`, { model: 'm-r', stream: true, input: 'hi' })).text());
    const types = ev.map((e) => e.data.type);
    for (const t of ['response.created', 'response.output_item.added', 'response.output_text.delta', 'response.output_text.done', 'response.output_item.done', 'response.completed']) {
      expect(types).toContain(t);
    }
    expect(types.at(-1)).toBe('response.completed');
    const u = ev.at(-1).data.response.usage;
    expect(u.total_tokens).toBe(u.input_tokens + u.output_tokens);
    const last = s.lines().at(-1);
    expect(last.usage).toEqual(u);
    expect(last.normalized.input).toBe(u.input_tokens - u.input_tokens_details.cached_tokens);

    const j = await (await post(`${s.base}/responses`, { model: 'm-r', input: 'hi' })).json();
    expect(j.object).toBe('response');
    expect(j.usage.output_tokens_details.reasoning_tokens).toBeGreaterThan(0);
  });

  it('gemini generateContent and streamGenerateContent', async () => {
    const j = await (await post(`${s.base}/v1beta/models/gem-x:generateContent`, { contents: [] }, { 'x-goog-api-key': 'k' })).json();
    const m = j.usageMetadata;
    expect(m.totalTokenCount).toBe(m.promptTokenCount + m.candidatesTokenCount + m.thoughtsTokenCount);
    let last = s.lines().at(-1);
    expect(last).toMatchObject({ protocol: 'gemini', model: 'gem-x', stream: false });
    expect(last.normalized.input).toBe(m.promptTokenCount - m.cachedContentTokenCount);
    expect(last.normalized.output).toBe(m.candidatesTokenCount + m.thoughtsTokenCount);

    const text = await (await post(`${s.base}/v1beta/models/gem-x:streamGenerateContent?alt=sse`, { contents: [] })).text();
    const chunks = sse(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1).data.candidates[0].finishReason).toBe('STOP');
    last = s.lines().at(-1);
    expect(last.stream).toBe(true);
    expect(last.usage).toEqual(chunks.at(-1).data.usageMetadata);
  });

  it('models lists in each flavour', async () => {
    const oa = await (await fetch(`${s.base}/v1/models`)).json();
    expect(oa.object).toBe('list');
    const an = await (await fetch(`${s.base}/v1/models`, { headers: { 'anthropic-version': '2023-06-01' } })).json();
    expect(an.data[0].type).toBe('model');
    expect(an).toHaveProperty('has_more');
    const g = await (await fetch(`${s.base}/v1beta/models`)).json();
    expect(g.models[0].name).toMatch(/^models\//);
  });

  it('logs unknown paths as 404', async () => {
    const r = await fetch(`${s.base}/v1/nope`);
    expect(r.status).toBe(404);
    expect(s.lines().at(-1)).toMatchObject({ status: 404, endpoint: 'GET /v1/nope', usage: null });
  });

  it('gives every response distinct usage numbers', () => {
    const rows = s.lines().filter((l) => l.usage);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const key = (l) => JSON.stringify(l.normalized);
    expect(new Set(rows.map(key)).size).toBe(rows.length);
    expect(new Set(rows.map((l) => l.normalized.input)).size).toBe(rows.length);
  });
});

describe('fake-llm flags', () => {
  it('--always-usage adds usage to chat streams', async () => {
    const s = await start(['--always-usage']);
    try {
      const ev = sse(await (await post(`${s.base}/v1/chat/completions`, { model: 'x', stream: true, messages: [] })).text());
      expect(ev.some((e) => e.data?.usage)).toBe(true);
    } finally { await s.stop(); }
  });

  it('--tool-turns asks for a read-only tool for the first turns only', async () => {
    const s = await start(['--tool-turns', '1']);
    try {
      const tools = [WRITE_TOOL, READ_TOOL];
      // Anthropic
      let j = await (await post(`${s.base}/v1/messages`, { model: 'x', messages: [{ role: 'user', content: 'a' }], tools: tools.map((t) => ({ name: t.name, input_schema: t.schema })) })).json();
      expect(j.stop_reason).toBe('tool_use');
      expect(j.content[0]).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'README.md' } });
      j = await (await post(`${s.base}/v1/messages`, { model: 'x', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [] }, { role: 'user', content: 'r' }], tools: tools.map((t) => ({ name: t.name, input_schema: t.schema })) })).json();
      expect(j.stop_reason).toBe('end_turn');
      // Chat
      j = await (await post(`${s.base}/v1/chat/completions`, { model: 'x', messages: [], tools: tools.map((t) => ({ type: 'function', function: { name: t.name, parameters: t.schema } })) })).json();
      expect(j.choices[0].finish_reason).toBe('tool_calls');
      expect(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: 'README.md' });
      // Responses (streamed)
      let ev = sse(await (await post(`${s.base}/v1/responses`, { model: 'x', stream: true, input: [], tools: tools.map((t) => ({ type: 'function', name: t.name, parameters: t.schema })) })).text());
      expect(ev.at(-1).data.response.output[0]).toMatchObject({ type: 'function_call', name: 'read_file' });
      // Gemini
      j = await (await post(`${s.base}/v1beta/models/g:generateContent`, { contents: [], tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, parameters: t.schema })) }] })).json();
      expect(j.candidates[0].content.parts[0].functionCall).toMatchObject({ name: 'read_file', args: { path: 'README.md' } });
      // No suitable tool: plain text
      j = await (await post(`${s.base}/v1/messages`, { model: 'x', messages: [], tools: [{ name: 'write_file', input_schema: WRITE_TOOL.schema }] })).json();
      expect(j.content[0].type).toBe('text');
      expect(s.lines().some((l) => l.toolCall === 'read_file')).toBe(true);
    } finally { await s.stop(); }
  });

  it('--exit-on-stdin-close exits when stdin closes', async () => {
    const s = await start(['--exit-on-stdin-close']);
    const exited = new Promise((r) => s.child.on('exit', r));
    s.child.stdin.end();
    await exited;
    await s.stop();
  });
});
