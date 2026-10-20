#!/usr/bin/env node
// Dev-only fake LLM server for end-to-end agent checks. See README.md in this folder.
// Plain Node ESM, no dependencies. Answers like Anthropic, OpenAI (chat + responses) and
// Gemini, gives every response distinct known usage numbers and logs them as JSONL.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import * as zlib from 'node:zlib';

const DEFAULT_MODELS = [
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'gpt-5',
  'gpt-5-codex',
  'gpt-4.1',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

function parseArgs(argv) {
  const opts = {
    port: 0,
    log: null,
    models: DEFAULT_MODELS,
    toolTurns: 0,
    alwaysUsage: false,
    exitOnStdinClose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--port': opts.port = Number(value()); break;
      case '--log': opts.log = value(); break;
      case '--models': opts.models = value().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--tool-turns': opts.toolTurns = Number(value()); break;
      case '--always-usage': opts.alwaysUsage = true; break;
      case '--exit-on-stdin-close': opts.exitOnStdinClose = true; break;
      default:
        process.stderr.write(`fake-llm: unknown flag ${argv[i]}\n`);
        process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0) throw new Error('--port must be a non-negative integer');
  if (!Number.isInteger(opts.toolTurns) || opts.toolTurns < 0) throw new Error('--tool-turns must be a non-negative integer');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.log) writeFileSync(opts.log, '');

let counter = 0;

/** Usage for response number n, as the exclusive view (input = fresh input only). */
function usageFor(n) {
  return {
    input: 1000 + 7 * n,
    output: 50 + 3 * n, // includes reasoning for OpenAI and Gemini
    cacheRead: 200 + 11 * n,
    cacheWrite: 30 + 5 * n, // Anthropic only
    reasoning: 5 + n,
  };
}

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  if (opts.log) appendFileSync(opts.log, line + '\n');
  process.stderr.write(`${entry.status ?? 200} ${entry.protocol ?? '-'} ${entry.endpoint}${entry.usage ? ' usage ' + JSON.stringify(entry.normalized) : ''}\n`);
}

// ---------- request helpers ----------

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let buf = Buffer.concat(chunks);
  const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
  try {
    if (enc === 'gzip') buf = zlib.gunzipSync(buf);
    else if (enc === 'deflate') buf = zlib.inflateSync(buf);
    else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
    else if (enc === 'zstd') buf = zlib.zstdDecompressSync(buf);
  } catch {
    return { body: {}, parsed: false };
  }
  if (buf.length === 0) return { body: {}, parsed: true };
  try {
    const body = JSON.parse(buf.toString('utf8'));
    return { body: body && typeof body === 'object' ? body : {}, parsed: true };
  } catch {
    return { body: {}, parsed: false };
  }
}

const READ_ONLY = /read|list|ls|glob|view/i;
const MUTATING = /write|edit|delete|remove|exec|bash|shell|run|patch|replace|create/i;

/** Pick a read-only tool from [{name, schema}] and build minimal valid arguments. */
function pickTool(tools) {
  const t = tools.find((x) => x.name && READ_ONLY.test(x.name) && !MUTATING.test(x.name));
  return t ? { name: t.name, args: buildArgs(t.schema, t.name) } : null;
}

function buildValue(schema, key, toolName) {
  if (!schema || typeof schema !== 'object') return '.';
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const alt = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alt) && alt.length) return buildValue(alt[0], key, toolName);
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? type[0];
  switch (type) {
    case 'string': {
      if (/pattern|glob/i.test(key)) return '*';
      if (/file|path/i.test(key) && /read|view/i.test(toolName)) return 'README.md';
      return '.';
    }
    case 'integer': case 'number': return Math.max(1, schema.minimum ?? 1);
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return buildArgs(schema, toolName);
    default: return '.';
  }
}

function buildArgs(schema, toolName) {
  const out = {};
  if (!schema || typeof schema !== 'object') return out;
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) out[key] = buildValue(props[key], key, toolName);
  return out;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// ---------- usage per protocol ----------

function anthropicUsage(u) {
  return {
    input_tokens: u.input,
    cache_creation_input_tokens: u.cacheWrite,
    cache_read_input_tokens: u.cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite - u.reasoning, ephemeral_1h_input_tokens: u.reasoning },
    output_tokens: u.output,
    service_tier: 'standard',
  };
}
function chatUsage(u) {
  const prompt = u.input + u.cacheRead;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output,
    total_tokens: prompt + u.output,
    prompt_tokens_details: { cached_tokens: u.cacheRead, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: u.reasoning, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };
}
function responsesUsage(u) {
  const input = u.input + u.cacheRead;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.cacheRead },
    output_tokens: u.output,
    output_tokens_details: { reasoning_tokens: u.reasoning },
    total_tokens: input + u.output,
  };
}
function geminiUsage(u) {
  const prompt = u.input + u.cacheRead;
  const candidates = u.output - u.reasoning;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    cachedContentTokenCount: u.cacheRead,
    thoughtsTokenCount: u.reasoning,
    totalTokenCount: prompt + candidates + u.reasoning,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: prompt }],
  };
}

// ---------- SSE ----------

function startSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}
const sseNamed = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
const sseData = (res, data) => res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const textParts = (n) => ['ok', ` ${n}`];

// ---------- protocol handlers ----------
// Each takes ctx { body, model, stream, n, u, tool, res, finish } and returns { usage, sent }.
// `tool` is { name, args } when this response should call a tool.

function anthropic({ body, model, stream, n, u, tool, res }) {
  const id = `msg_fake${n}`;
  const usage = anthropicUsage(u);
  const toolId = `toolu_fake${n}`;
  const stop = tool ? 'tool_use' : 'end_turn';
  const content = tool
    ? [{ type: 'tool_use', id: toolId, name: tool.name, input: tool.args }]
    : [{ type: 'text', text: textParts(n).join('') }];
  if (!stream) {
    sendJson(res, 200, { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage });
    return { usage, sent: true };
  }
  startSse(res);
  const { output_tokens, ...startUsage } = usage;
  sseNamed(res, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...startUsage, output_tokens: 1 } },
  });
  sseNamed(res, 'ping', { type: 'ping' });
  if (tool) {
    sseNamed(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: tool.name, input: {} } });
    const json = JSON.stringify(tool.args);
    const mid = Math.ceil(json.length / 2);
    for (const part of [json.slice(0, mid), json.slice(mid)]) {
      sseNamed(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: part } });
    }
  } else {
    sseNamed(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const t of textParts(n)) sseNamed(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
  }
  sseNamed(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseNamed(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens } });
  sseNamed(res, 'message_stop', { type: 'message_stop' });
  return { usage, sent: true };
}

function chat({ body, model, stream, n, u, tool, res }) {
  const id = `chatcmpl-fake${n}`;
  const created = Math.floor(Date.now() / 1000);
  const callId = `call_fake${n}`;
  const finish = tool ? 'tool_calls' : 'stop';
  const usage = chatUsage(u);
  const base = { id, object: 'chat.completion', created, model, system_fingerprint: 'fp_fake' };
  if (!stream) {
    const message = tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: 'assistant', content: textParts(n).join(''), refusal: null };
    sendJson(res, 200, { ...base, choices: [{ index: 0, message, logprobs: null, finish_reason: finish }], usage });
    return { usage, sent: true };
  }
  const chunk = (delta, finish_reason = null, extra = {}) =>
    sseData(res, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, logprobs: null, finish_reason }], ...extra });
  startSse(res);
  chunk({ role: 'assistant', content: tool ? null : '', refusal: null });
  if (tool) {
    chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool.name, arguments: '' } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] });
  } else {
    for (const t of textParts(n)) chunk({ content: t });
  }
  chunk({}, finish);
  const wantUsage = body.stream_options?.include_usage === true || opts.alwaysUsage;
  if (wantUsage) sseData(res, { ...base, object: 'chat.completion.chunk', choices: [], usage });
  sseData(res, '[DONE]');
  return { usage: wantUsage ? usage : null, sent: wantUsage };
}

function responses({ body, model, stream, n, u, tool, res }) {
  const respId = `resp_fake${n}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = responsesUsage(u);
  const text = textParts(n).join('');
  const msgItem = (status, parts) => ({ id: `msg_fake${n}`, type: 'message', status, role: 'assistant', content: parts });
  const textPart = (t) => ({ type: 'output_text', text: t, annotations: [], logprobs: [] });
  const fcItem = (status, args) => ({ id: `fc_fake${n}`, type: 'function_call', status, call_id: `call_fake${n}`, name: tool?.name, arguments: args });
  const finalItem = tool ? fcItem('completed', JSON.stringify(tool.args)) : msgItem('completed', [textPart(text)]);
  const respObj = (status, output, usageObj) => ({
    id: respId, object: 'response', created_at: created, status, model, output,
    error: null, incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: true,
    temperature: 1, tool_choice: 'auto', tools: [], top_p: 1, store: false, usage: usageObj,
  });
  if (!stream) {
    sendJson(res, 200, respObj('completed', [finalItem], usage));
    return { usage, sent: true };
  }
  startSse(res);
  let seq = 0;
  const ev = (type, data) => sseNamed(res, type, { type, sequence_number: seq++, ...data });
  ev('response.created', { response: respObj('in_progress', [], null) });
  ev('response.in_progress', { response: respObj('in_progress', [], null) });
  if (tool) {
    const args = JSON.stringify(tool.args);
    ev('response.output_item.added', { output_index: 0, item: fcItem('in_progress', '') });
    ev('response.function_call_arguments.delta', { item_id: `fc_fake${n}`, output_index: 0, delta: args });
    ev('response.function_call_arguments.done', { item_id: `fc_fake${n}`, output_index: 0, arguments: args });
  } else {
    ev('response.output_item.added', { output_index: 0, item: msgItem('in_progress', []) });
    ev('response.content_part.added', { item_id: `msg_fake${n}`, output_index: 0, content_index: 0, part: textPart('') });
    for (const t of textParts(n)) ev('response.output_text.delta', { item_id: `msg_fake${n}`, output_index: 0, content_index: 0, delta: t, logprobs: [] });
    ev('response.output_text.done', { item_id: `msg_fake${n}`, output_index: 0, content_index: 0, text, logprobs: [] });
    ev('response.content_part.done', { item_id: `msg_fake${n}`, output_index: 0, content_index: 0, part: textPart(text) });
  }
  ev('response.output_item.done', { output_index: 0, item: finalItem });
  ev('response.completed', { response: respObj('completed', [finalItem], usage) });
  return { usage, sent: true };
}

function gemini({ model, stream, n, u, tool, res }) {
  const usage = geminiUsage(u);
  const parts = tool ? [{ functionCall: { name: tool.name, args: tool.args } }] : null;
  const cand = (ps, finish) => ({ content: { role: 'model', parts: ps }, ...(finish ? { finishReason: 'STOP' } : {}), index: 0 });
  const meta = { modelVersion: model, responseId: `resp_fake${n}` };
  if (!stream) {
    sendJson(res, 200, { candidates: [cand(parts ?? [{ text: textParts(n).join('') }], true)], usageMetadata: usage, ...meta });
    return { usage, sent: true };
  }
  startSse(res);
  // Real Gemini repeats cumulative usageMetadata on every chunk; so do we (identical values).
  if (tool) {
    sseData(res, { candidates: [cand(parts, true)], usageMetadata: usage, ...meta });
  } else {
    const [a, b] = textParts(n);
    sseData(res, { candidates: [cand([{ text: a }], false)], usageMetadata: usage, ...meta });
    sseData(res, { candidates: [cand([{ text: b }], true)], usageMetadata: usage, ...meta });
  }
  return { usage, sent: true };
}

// ---------- conversation turn + tool extraction per protocol ----------

const extract = {
  anthropic(body) {
    const msgs = asArray(body.messages);
    return {
      turns: msgs.filter((m) => m?.role === 'assistant').length,
      tools: asArray(body.tools).map((t) => ({ name: t?.name, schema: t?.input_schema })),
    };
  },
  chat(body) {
    const msgs = asArray(body.messages);
    return {
      turns: msgs.filter((m) => m?.role === 'assistant' || m?.role === 'tool').length,
      tools: asArray(body.tools).map((t) => ({ name: t?.function?.name ?? t?.name, schema: t?.function?.parameters ?? t?.parameters })),
    };
  },
  responses(body) {
    const items = asArray(body.input);
    return {
      turns: items.filter((i) => i?.role === 'assistant' || i?.type === 'function_call' || i?.type === 'function_call_output' || i?.type === 'reasoning').length,
      tools: asArray(body.tools).map((t) => ({ name: t?.name ?? t?.function?.name, schema: t?.parameters ?? t?.function?.parameters })),
    };
  },
  gemini(body) {
    const contents = asArray(body.contents);
    const tools = asArray(body.tools).flatMap((t) => asArray(t?.functionDeclarations ?? t?.function_declarations));
    return {
      turns: contents.filter((c) => c?.role === 'model' || asArray(c?.parts).some((p) => p?.functionResponse || p?.function_response)).length,
      tools: tools.map((t) => ({ name: t?.name, schema: t?.parametersJsonSchema ?? t?.parameters })),
    };
  },
};

const handlers = { anthropic, chat, responses, gemini };

// ---------- routing ----------

function route(method, pathname) {
  const p = pathname.replace(/\/+$/, '');
  if (method === 'POST') {
    if (/(?:^|\/)messages\/count_tokens$/.test(p)) return { kind: 'count', protocol: 'anthropic' };
    if (/(?:^|\/)messages$/.test(p)) return { kind: 'completion', protocol: 'anthropic' };
    if (/(?:^|\/)chat\/completions$/.test(p)) return { kind: 'completion', protocol: 'chat' };
    if (/(?:^|\/)responses$/.test(p)) return { kind: 'completion', protocol: 'responses' };
    const g = /(?:^|\/)models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/.exec(p);
    if (g) {
      const model = decodeURIComponent(g[1]);
      if (g[2] === 'countTokens') return { kind: 'count', protocol: 'gemini', model };
      return { kind: 'completion', protocol: 'gemini', model, stream: g[2] === 'streamGenerateContent' };
    }
  }
  if (method === 'GET') {
    if (/(?:^|\/)models$/.test(p)) return { kind: 'models' };
    const m = /(?:^|\/)models\/([^/:]+)$/.exec(p);
    if (m) return { kind: 'model', model: decodeURIComponent(m[1]) };
  }
  return null;
}

function listModels(req, pathname) {
  const ids = opts.models;
  const now = Math.floor(Date.now() / 1000);
  if (/v1beta\//.test(pathname) || req.headers['x-goog-api-key']) {
    return { models: ids.map((id) => ({ name: `models/${id}`, version: '001', displayName: id, description: id, inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens', 'streamGenerateContent'] })) };
  }
  if (req.headers['anthropic-version']) {
    return { data: ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z' })), has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null };
  }
  return { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: now, owned_by: 'fake-llm' })) };
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const endpoint = `${req.method} ${url.pathname}`;
  const r = route(req.method ?? 'GET', url.pathname);

  if (!r) {
    await readBody(req);
    log({ status: 404, protocol: null, endpoint, model: null, responseId: null, stream: false, usage: null, normalized: null });
    return sendJson(res, 404, { error: { type: 'not_found_error', message: `fake-llm: no route for ${endpoint}` } });
  }
  if (r.kind === 'models' || r.kind === 'model') {
    const list = listModels(req, url.pathname);
    let payload = list;
    if (r.kind === 'model') {
      const one = (list.data ?? list.models).find((m) => (m.id ?? m.name.replace(/^models\//, '')) === r.model);
      payload = one ?? null;
    }
    log({ status: payload ? 200 : 404, protocol: null, endpoint, model: r.model ?? null, responseId: null, stream: false, usage: null, normalized: null });
    return payload ? sendJson(res, 200, payload) : sendJson(res, 404, { error: { type: 'not_found_error', message: 'model not found' } });
  }

  const { body, parsed } = await readBody(req);
  const model = body.model ?? r.model ?? 'fake-model';

  if (r.kind === 'count') {
    log({ status: 200, protocol: r.protocol, endpoint, model, responseId: null, stream: false, usage: null, normalized: null });
    return sendJson(res, 200, r.protocol === 'gemini' ? { totalTokens: 42 } : { input_tokens: 42 });
  }

  const n = ++counter;
  const u = usageFor(n);
  const stream = r.protocol === 'gemini' ? r.stream : body.stream === true;
  const { turns, tools } = extract[r.protocol](body);
  const tool = turns < opts.toolTurns ? pickTool(tools) : null;
  const responseId = { anthropic: `msg_fake${n}`, chat: `chatcmpl-fake${n}`, responses: `resp_fake${n}`, gemini: `resp_fake${n}` }[r.protocol];

  const out = handlers[r.protocol]({ body, model, stream, n, u, tool, res });
  log({
    status: 200, protocol: r.protocol, endpoint, model, responseId, stream, bodyParsed: parsed,
    toolCall: tool ? tool.name : null,
    usage: out.usage,
    normalized: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: r.protocol === 'anthropic' ? u.cacheWrite : 0 },
    usageSent: out.sent,
  });
  res.end();
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    process.stderr.write(`fake-llm: ${err?.stack ?? err}\n`);
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
    else res.end();
  });
});

function shutdown() {
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (opts.exitOnStdinClose) {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}

server.listen(opts.port, '127.0.0.1', () => {
  process.stdout.write(`READY ${server.address().port}\n`);
});
