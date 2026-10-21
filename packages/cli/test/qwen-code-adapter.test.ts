import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonObjects } from '../src/adapters/qwen-code/aggregator.js';
import { createQwenCodeAdapter, qwenHome, qwenProjectsDirs, qwenSettingsPath, qwenUsageDirs } from '../src/adapters/qwen-code/index.js';

const SINCE = new Date('2026-01-01T00:00:00Z');
const SECRET = 'SECRET-PROMPT-TEXT /Users/someone/private';

type Json = Record<string, unknown>;

function usageMetadata(extra: Json = {}): Json {
  return { promptTokenCount: 12000, candidatesTokenCount: 300, cachedContentTokenCount: 9000, thoughtsTokenCount: 40, totalTokenCount: 12300, ...extra };
}

function assistant(extra: Json = {}): Json {
  return {
    uuid: 'u-1',
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-10-17T10:00:00.000Z',
    type: 'assistant',
    cwd: '/Users/someone/private',
    version: '0.25.2',
    model: 'qwen3-coder-plus',
    message: { role: 'model', parts: [{ text: SECRET }] },
    usageMetadata: usageMetadata(),
    contextWindowSize: 1000000,
    ...extra,
  };
}

function ledgerRecord(extra: Json = {}): Json {
  return {
    schemaVersion: 1,
    id: 'l-1',
    timestamp: '2026-10-18T19:21:47.464Z',
    localDate: '2026-10-18',
    localMonth: '2026-10',
    sessionId: 'SECRET-SESSION',
    model: 'qwen3-coder-plus',
    authType: 'openai',
    source: 'main',
    inputTokens: 1210,
    outputTokens: 32,
    cachedTokens: 203,
    thoughtsTokens: 0,
    totalTokens: 1242,
    apiDurationMs: 73,
    ...extra,
  };
}

// The two real lines from a Qwen Code 0.25.2 run: the main request and the memory extractor's.
const REAL_MAIN = ledgerRecord({ id: 'b2560b63-0292-4c84-b6a4-6fc101d47731' });
const REAL_EXTRACTOR = ledgerRecord({
  id: '831cd12e-9682-4263-ae8f-23412bdf9e78',
  timestamp: '2026-10-18T19:21:47.518Z',
  source: 'managed-auto-memory-extractor',
  inputTokens: 1220,
  outputTokens: 34,
  cachedTokens: 206,
  totalTokens: 1254,
});

describe('qwen code adapter', () => {
  let root: string;
  let qwen: string;
  let projectDir: string;
  const saved = { home: process.env['QWEN_HOME'], runtime: process.env['QWEN_RUNTIME_DIR'] };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'qwen-home-'));
    qwen = join(root, '.qwen');
    projectDir = join(qwen, 'projects', '-Users-someone-proj');
    await mkdir(join(projectDir, 'chats'), { recursive: true });
    process.env['QWEN_HOME'] = qwen;
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  afterEach(async () => {
    for (const [key, value] of [['QWEN_HOME', saved.home], ['QWEN_RUNTIME_DIR', saved.runtime]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const write = (path: string, lines: unknown[]) =>
    writeFile(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  const chat = (name: string, lines: unknown[]) => write(join(projectDir, 'chats', name), lines);
  async function subagent(session: string, agent: string, lines: unknown[], meta?: unknown) {
    const dir = join(projectDir, 'subagents', session);
    await mkdir(dir, { recursive: true });
    await write(join(dir, `agent-${agent}.jsonl`), lines);
    if (meta !== undefined) await writeFile(join(dir, `agent-${agent}.meta.json`), JSON.stringify(meta));
  }
  const ledger = async (name: string, lines: unknown[], dir = join(qwen, 'usage')) => {
    await mkdir(dir, { recursive: true });
    await write(join(dir, name), lines);
  };
  const collect = (since = SINCE) => createQwenCodeAdapter({ timeZone: 'UTC' }).collect(since);

  it('resolves the folders from QWEN_HOME and QWEN_RUNTIME_DIR, with ~ expansion', () => {
    delete process.env['QWEN_HOME'];
    expect(qwenHome()).toBe(join(homedir(), '.qwen'));
    expect(qwenSettingsPath()).toBe(join(homedir(), '.qwen', 'settings.json'));
    process.env['QWEN_HOME'] = '~/custom-qwen';
    expect(qwenHome()).toBe(join(homedir(), 'custom-qwen'));
    expect(qwenProjectsDirs()).toEqual([join(homedir(), 'custom-qwen', 'projects')]);
    process.env['QWEN_RUNTIME_DIR'] = '~/runtime';
    expect(qwenProjectsDirs()).toEqual([join(homedir(), 'runtime', 'projects'), join(homedir(), 'custom-qwen', 'projects')]);
    process.env['QWEN_RUNTIME_DIR'] = '~/custom-qwen';
    expect(qwenProjectsDirs()).toHaveLength(1);
  });

  it('is named qwen-code and detects only an existing projects folder', async () => {
    const adapter = createQwenCodeAdapter();
    expect(adapter.name).toBe('qwen-code');
    expect(await adapter.detect()).toBe(true);
    await rm(join(qwen, 'projects'), { recursive: true });
    expect(await adapter.detect()).toBe(false);
  });

  it('folds cache into the prompt: fresh input = prompt - cached, output never adds thoughts', async () => {
    await chat('a.jsonl', [assistant()]);
    const result = await collect();
    expect(result.source).toBe('qwen-code');
    expect(result.requestCount).toBe(1);
    // 3000 + 300 + 0.1 * 9000, at 10:00 UTC.
    expect(result.hours).toEqual([{ date: '2026-10-17', hour: 10, weighted: 4200 }]);
    expect(result.usage).toEqual([
      {
        date: '2026-10-17',
        model: 'qwen3-coder-plus',
        pricingTier: 'standard',
        counts: { inputTokens: 3000, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 9000, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
      },
    ]);
    expect(result.notes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('/Users/');
  });

  it('takes output from total - prompt when thoughts sit outside candidates (Gemini-native)', async () => {
    await chat('a.jsonl', [
      assistant({ usageMetadata: usageMetadata({ promptTokenCount: 100, candidatesTokenCount: 50, cachedContentTokenCount: 0, thoughtsTokenCount: 30, totalTokenCount: 180 }) }),
    ]);
    expect((await collect()).usage[0]!.counts).toMatchObject({ inputTokens: 100, outputTokens: 80 });
  });

  it('uses candidates when total is absent or smaller, and defaults absent counters to 0', async () => {
    await chat('a.jsonl', [
      assistant({ uuid: 'u-1', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7 } }),
      assistant({ uuid: 'u-2', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7, totalTokenCount: 12 } }),
      // The Anthropic path omits candidates when the stream never reported output.
      assistant({ uuid: 'u-3', usageMetadata: { promptTokenCount: 10 } }),
    ]);
    expect((await collect()).usage[0]!.counts).toMatchObject({ inputTokens: 30, outputTokens: 14, cacheReadTokens: 0 });
  });

  it('counts cache-creation tokens folded into the prompt as fresh input', async () => {
    // Anthropic protocol: prompt = input 50 + cache read 900 + cache creation 400.
    await chat('a.jsonl', [assistant({ model: 'claude-sonnet-4-5', usageMetadata: usageMetadata({ promptTokenCount: 1350, cachedContentTokenCount: 900, candidatesTokenCount: 20, totalTokenCount: 1370 }) })]);
    const counts = (await collect()).usage[0]!.counts;
    expect(counts).toMatchObject({ inputTokens: 450, cacheCreationTokens: 0, cacheReadTokens: 900, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
  });

  it('counts a request once when a /branch fork copies its record into another file', async () => {
    const original = assistant({ uuid: 'u-1' });
    await chat('parent.jsonl', [original, assistant({ uuid: 'u-2', timestamp: '2026-10-17T10:01:00.000Z' })]);
    await chat('fork.jsonl', [{ ...original, sessionId: 'sess-2', parentUuid: 'x', forkedFrom: { sessionId: 'sess-1', messageUuid: 'u-1' } }]);
    const result = await collect();
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 6000, outputTokens: 600, cacheReadTokens: 18000 });
  });

  it('keeps the first copy date and model when a later copy disagrees', async () => {
    await chat('a.jsonl', [assistant()]);
    await chat('b.jsonl', [assistant({ timestamp: '2026-10-18T10:00:00.000Z', model: 'other' })]);
    const { usage } = await collect();
    expect(usage.map((row) => [row.date, row.model])).toEqual([['2026-10-17', 'qwen3-coder-plus']]);
  });

  it('ignores user, tool_result and system records, including ui_telemetry copies of usage', async () => {
    await chat('a.jsonl', [
      assistant({ uuid: 'u-1' }),
      assistant({ uuid: 'u-2', type: 'user' }),
      assistant({ uuid: 'u-3', type: 'tool_result' }),
      assistant({ uuid: 'u-4', type: 'system', subtype: 'ui_telemetry' }),
      // An assistant record with no usage is not a request.
      assistant({ uuid: 'u-5', usageMetadata: undefined }),
    ]);
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.notes).toBeUndefined();
  });

  it('reads only .jsonl files under chats and subagents', async () => {
    await chat('a.jsonl', [assistant({ uuid: 'u-1' })]);
    await chat('a.runtime.json', [assistant({ uuid: 'u-2' })]);
    await mkdir(join(projectDir, 'tool-results'), { recursive: true });
    await write(join(projectDir, 'tool-results', 'x.jsonl'), [assistant({ uuid: 'u-3' })]);
    await subagent('sess-1', 'ag1', [assistant({ uuid: 'u-4' })], { model: 'qwen3-coder-plus' });
    await write(join(projectDir, 'subagents', 'sess-1', 'agent-ag1.jsonl.stream'), [assistant({ uuid: 'u-5' })]);
    expect((await collect()).requestCount).toBe(2);
  });

  it('reads background subagent transcripts and takes their model from the meta sidecar', async () => {
    const noModel = { type: 'assistant', uuid: 's-1', timestamp: '2026-10-17T11:00:00.000Z', usageMetadata: usageMetadata(), message: { parts: [{ text: SECRET }] } };
    await subagent('sess-1', 'a', [noModel], { agentId: 'a', description: SECRET, model: 'qwen3-max' });
    await subagent('sess-1', 'b', [{ ...noModel, uuid: 's-2' }], { agentId: 'b', persistedCliFlags: { model: 'qwen3-coder-flash' } });
    await subagent('sess-1', 'c', [{ ...noModel, uuid: 's-3' }], { agentId: 'c' });
    await subagent('sess-1', 'd', [{ ...noModel, uuid: 's-4' }]);
    // A record that names its own model keeps it.
    await subagent('sess-1', 'e', [{ ...noModel, uuid: 's-5', model: 'qwen3-coder-plus' }], { model: 'qwen3-max' });
    const result = await collect();
    expect(result.requestCount).toBe(5);
    expect(Object.fromEntries(result.usage.map((row) => [row.model, row.counts.inputTokens]))).toEqual({
      'qwen3-max': 3000,
      'qwen3-coder-flash': 3000,
      unknown: 6000,
      'qwen3-coder-plus': 3000,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('tolerates glued records on one line and skips unparseable lines silently', async () => {
    const one = JSON.stringify(assistant({ uuid: 'u-1', message: { parts: [{ text: 'brace } { inside "string"' }] } }));
    const two = JSON.stringify(assistant({ uuid: 'u-2' }));
    await chat('a.jsonl', [`${one}${two}`, '{"uuid": "partial', '', 'not json']);
    const result = await collect();
    expect(result.requestCount).toBe(2);
    expect(result.notes).toBeUndefined();
  });

  it('skips and reports malformed usage, and a valid copy of the same uuid clears it', async () => {
    await chat('a.jsonl', [
      assistant({ uuid: 'ok' }),
      assistant({ uuid: 'no-prompt', usageMetadata: { candidatesTokenCount: 5, totalTokenCount: 5 } }),
      assistant({ uuid: 'negative', usageMetadata: usageMetadata({ cachedContentTokenCount: -1 }) }),
      assistant({ uuid: 'fraction', usageMetadata: usageMetadata({ promptTokenCount: 1.5 }) }),
      assistant({ uuid: 'bad-time', timestamp: 'yesterday' }),
      assistant({ uuid: 'cleared', usageMetadata: { candidatesTokenCount: 5 } }),
      { type: 'assistant', timestamp: '2026-10-17T10:00:00.000Z', usageMetadata: usageMetadata() },
    ]);
    await chat('b.jsonl', [assistant({ uuid: 'cleared' })]);
    const result = await collect();
    expect(result.requestCount).toBe(2);
    expect(result.notes).toEqual(['skipped 5 Qwen Code record(s) with missing or invalid token counts, uuid or timestamp']);
  });

  it('counts cached above the prompt as 0 fresh input and reports it once per uuid', async () => {
    await chat('a.jsonl', [assistant({ uuid: 'c', usageMetadata: usageMetadata({ promptTokenCount: 100, cachedContentTokenCount: 500, totalTokenCount: 400 }) })]);
    await chat('b.jsonl', [assistant({ uuid: 'c', usageMetadata: usageMetadata({ promptTokenCount: 100, cachedContentTokenCount: 500, totalTokenCount: 400 }) })]);
    const result = await collect();
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 0, cacheReadTokens: 500 });
    expect(result.notes).toEqual(['1 Qwen Code record(s) reported more cached than prompt tokens; counted as 0 fresh input']);
  });

  it('drops requests before since, and files not touched since', async () => {
    await chat('old.jsonl', [assistant({ uuid: 'o', timestamp: '2025-12-31T23:59:59.000Z' }), assistant({ uuid: 'n', timestamp: '2026-01-01T00:00:00.000Z' })]);
    await chat('stale.jsonl', [assistant({ uuid: 's' })]);
    await utimes(join(projectDir, 'chats', 'stale.jsonl'), new Date('2025-06-01'), new Date('2025-06-01'));
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.date).toBe('2026-01-01');
  });

  it('keeps a free-form model id as the tool wrote it, and an empty one as unknown', async () => {
    await chat('a.jsonl', [assistant({ model: 'my-company/custom-model' }), assistant({ uuid: 'u-2', model: '' })]);
    expect((await collect()).usage.map((row) => row.model).sort()).toEqual(['my-company/custom-model', 'unknown']);
  });

  describe('token usage ledger', () => {
    // The same main request as the chat record `assistant({ uuid: 'main' })` below, on the ledger.
    const chatMain = (extra: Json = {}) =>
      assistant({
        uuid: 'main',
        timestamp: '2026-10-18T19:21:47.400Z',
        usageMetadata: usageMetadata({ promptTokenCount: 1210, cachedContentTokenCount: 203, candidatesTokenCount: 32, totalTokenCount: 1242 }),
        ...extra,
      });

    it('is read on its own, and also makes the adapter detect', async () => {
      await rm(join(qwen, 'projects'), { recursive: true });
      expect(await createQwenCodeAdapter().detect()).toBe(false);
      await ledger('token-usage-2026-10.jsonl', [REAL_MAIN, REAL_EXTRACTOR]);
      expect(await createQwenCodeAdapter().detect()).toBe(true);
      const result = await collect();
      expect(result.requestCount).toBe(2);
      expect(result.usage).toEqual([
        {
          date: '2026-10-18',
          model: 'qwen3-coder-plus',
          pricingTier: 'standard',
          counts: { inputTokens: 1007 + 1014, outputTokens: 66, cacheCreationTokens: 0, cacheReadTokens: 409, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
        },
      ]);
      expect(result.notes).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('lists the usage folders next to the projects folders', () => {
      process.env['QWEN_RUNTIME_DIR'] = join(root, 'runtime');
      expect(qwenUsageDirs()).toEqual([join(root, 'runtime', 'usage'), join(qwen, 'usage')]);
    });

    it('uses the ledger alone for a day when it holds the extra request, without double counting', async () => {
      await chat('a.jsonl', [chatMain()]);
      await ledger('token-usage-2026-10.jsonl', [REAL_MAIN, REAL_EXTRACTOR]);
      const result = await collect();
      expect(result.requestCount).toBe(2);
      expect(result.usage).toHaveLength(1);
      expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 2021, outputTokens: 66, cacheReadTokens: 409 });
    });

    it('takes a day before the ledger existed from the chats and a later day from the ledger', async () => {
      await chat('a.jsonl', [
        assistant({ uuid: 'old' }),
        chatMain(),
      ]);
      await ledger('token-usage-2026-10.jsonl', [REAL_MAIN, REAL_EXTRACTOR]);
      const result = await collect();
      expect(result.requestCount).toBe(3);
      expect(result.usage.map((row) => [row.date, row.counts.inputTokens])).toEqual([
        ['2026-10-17', 3000],
        ['2026-10-18', 2021],
      ]);
    });

    it('keeps the chats for a day where they are larger (statistics switched off mid-day)', async () => {
      await chat('a.jsonl', [chatMain(), assistant({ uuid: 'later', timestamp: '2026-10-18T20:00:00.000Z' })]);
      await ledger('token-usage-2026-10.jsonl', [REAL_MAIN]);
      const result = await collect();
      expect(result.requestCount).toBe(2);
      expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 1007 + 3000, cacheReadTokens: 203 + 9000 });
    });

    it('prefers the ledger on a tie', async () => {
      await chat('a.jsonl', [chatMain({ model: 'chat-model' })]);
      await ledger('token-usage-2026-10.jsonl', [REAL_MAIN]);
      expect((await collect()).usage.map((row) => row.model)).toEqual(['qwen3-coder-plus']);
    });

    it('counts a ledger id once across runtime dirs and months', async () => {
      const runtime = join(root, 'runtime');
      process.env['QWEN_RUNTIME_DIR'] = runtime;
      await ledger('token-usage-2026-10.jsonl', [REAL_MAIN], join(runtime, 'usage'));
      await ledger('token-usage-2026-10.jsonl', [REAL_MAIN, REAL_EXTRACTOR]);
      await ledger('token-usage-2026-11.jsonl', [REAL_MAIN]);
      const result = await collect();
      expect(result.requestCount).toBe(2);
      expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 2021, outputTokens: 66 });
    });

    it('skips other schema versions with one note', async () => {
      await ledger('token-usage-2026-10.jsonl', [
        REAL_MAIN,
        ledgerRecord({ id: 'v2-a', schemaVersion: 2 }),
        ledgerRecord({ id: 'v2-b', schemaVersion: 2 }),
        ledgerRecord({ id: 'v-none', schemaVersion: undefined }),
      ]);
      const result = await collect();
      expect(result.requestCount).toBe(1);
      expect(result.notes).toEqual(['skipped 3 Qwen Code usage ledger record(s) with an unknown schemaVersion']);
    });

    it('reports malformed ledger records, and a valid copy of the same id clears it', async () => {
      await ledger('token-usage-2026-10.jsonl', [
        REAL_MAIN,
        ledgerRecord({ id: 'no-input', inputTokens: undefined }),
        ledgerRecord({ id: 'negative', cachedTokens: -1 }),
        ledgerRecord({ id: 'fraction', outputTokens: 1.5 }),
        ledgerRecord({ id: 'bad-time', timestamp: 'yesterday' }),
        ledgerRecord({ id: 'cleared', inputTokens: -5 }),
        ledgerRecord({ id: undefined }),
      ]);
      await ledger('token-usage-2026-11.jsonl', [ledgerRecord({ id: 'cleared', timestamp: '2026-10-19T10:00:00.000Z' })]);
      const result = await collect();
      expect(result.requestCount).toBe(2);
      expect(result.notes).toEqual(['skipped 5 Qwen Code record(s) with missing or invalid token counts, uuid or timestamp']);
    });

    it('normalises like chat records: clamps cached above input, falls back without total, unknown model', async () => {
      await ledger('token-usage-2026-10.jsonl', [
        ledgerRecord({ id: 'clamp', inputTokens: 100, cachedTokens: 500, outputTokens: 5, totalTokens: 105 }),
        ledgerRecord({ id: 'no-total', inputTokens: 10, cachedTokens: 0, outputTokens: 7, totalTokens: undefined, model: '' }),
        ledgerRecord({ id: 'thoughts', inputTokens: 100, cachedTokens: 0, outputTokens: 50, totalTokens: 180, thoughtsTokens: 30, model: undefined }),
      ]);
      const result = await collect();
      expect(result.usage.map((row) => [row.model, row.counts.inputTokens, row.counts.outputTokens, row.counts.cacheReadTokens])).toEqual([['unknown', 110, 87, 0], ['qwen3-coder-plus', 0, 5, 500]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      expect(result.notes).toEqual(['1 Qwen Code record(s) reported more cached than prompt tokens; counted as 0 fresh input']);
    });

    it('filters ledger records by since and skips months before it', async () => {
      await ledger('token-usage-2025-11.jsonl', [ledgerRecord({ id: 'ancient', timestamp: '2025-11-05T10:00:00.000Z' })]);
      await ledger('token-usage-2025-12.jsonl', [
        ledgerRecord({ id: 'old', timestamp: '2025-12-31T23:59:59.000Z' }),
        ledgerRecord({ id: 'edge', timestamp: '2026-01-01T00:00:00.000Z' }),
      ]);
      await ledger('notes.jsonl', [ledgerRecord({ id: 'other-file' })]);
      const result = await collect();
      expect(result.requestCount).toBe(1);
      expect(result.usage[0]!.date).toBe('2026-01-01');
    });
  });

  // chmod cannot make a file unreadable on Windows.
  it.skipIf(process.platform === 'win32')('reports a file it cannot read', async () => {
    await chat('locked.jsonl', [assistant()]);
    await chmod(join(projectDir, 'chats', 'locked.jsonl'), 0o000);
    const result = await collect();
    expect(result.requestCount).toBe(0);
    expect(result.notes).toEqual(['1 session file(s) could not be read']);
  });
});

describe('parseJsonObjects', () => {
  it('splits glued objects, respecting braces inside strings and escapes', () => {
    expect(parseJsonObjects('{"a":1}{"b":"}{\\"}"}')).toEqual([{ a: 1 }, { b: '}{"}' }]);
    expect(parseJsonObjects('  {"a":1}  ')).toEqual([{ a: 1 }]);
    expect(parseJsonObjects('')).toEqual([]);
    expect(parseJsonObjects('[1]{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonObjects('{"a":1}{"b":')).toEqual([{ a: 1 }]);
  });
});
