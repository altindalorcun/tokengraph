import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPiAdapter, piAgentDir, piSessionDirs } from '../src/adapters/pi/index.js';

const SINCE = new Date('2026-01-01T00:00:00Z');
const SECRET = 'SECRET-PROMPT-TEXT /Users/someone/private';

type Json = Record<string, unknown>;

function usage(extra: Json = {}): Json {
  return { input: 12, output: 340, cacheRead: 50000, cacheWrite: 800, totalTokens: 51152, cost: { total: 0.5 }, ...extra };
}

function assistant(extra: { id?: string; message?: Json } = {}): Json {
  return {
    type: 'message',
    id: extra.id ?? 'b2c3d4e5',
    parentId: 'a1b2c3d4',
    timestamp: '2026-10-03T14:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: SECRET }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-5.1',
      responseId: 'resp_1',
      usage: usage(),
      stopReason: 'stop',
      timestamp: Date.parse('2026-10-03T14:00:00Z'),
      ...extra.message,
    },
  };
}

const header = { type: 'session', version: 3, id: 'sess', timestamp: '2026-10-03T13:59:00.000Z', cwd: '/Users/someone/private' };

describe('pi adapter', () => {
  let root: string;
  let agentDir: string;
  const saved = { dir: process.env['PI_CODING_AGENT_DIR'], session: process.env['PI_CODING_AGENT_SESSION_DIR'] };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-home-'));
    agentDir = join(root, 'agent');
    await mkdir(join(agentDir, 'sessions', '--proj--'), { recursive: true });
    process.env['PI_CODING_AGENT_DIR'] = agentDir;
    delete process.env['PI_CODING_AGENT_SESSION_DIR'];
  });

  afterEach(async () => {
    for (const [key, value] of [['PI_CODING_AGENT_DIR', saved.dir], ['PI_CODING_AGENT_SESSION_DIR', saved.session]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const sessionFile = (name: string, lines: unknown[], dir = join(agentDir, 'sessions', '--proj--')) =>
    writeFile(join(dir, name), lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  const collect = (since = SINCE) => createPiAdapter({ timeZone: 'UTC' }).collect(since);

  it('resolves the agent and session folders from the environment, with ~ expansion', () => {
    delete process.env['PI_CODING_AGENT_DIR'];
    expect(piAgentDir()).toBe(join(homedir(), '.pi', 'agent'));
    process.env['PI_CODING_AGENT_DIR'] = '~/custom-agent';
    expect(piAgentDir()).toBe(join(homedir(), 'custom-agent'));
    expect(piSessionDirs()).toEqual([join(homedir(), 'custom-agent', 'sessions')]);
    process.env['PI_CODING_AGENT_SESSION_DIR'] = '~/elsewhere';
    expect(piSessionDirs()).toEqual([join(homedir(), 'custom-agent', 'sessions'), join(homedir(), 'elsewhere')]);
    process.env['PI_CODING_AGENT_SESSION_DIR'] = join(homedir(), 'custom-agent', 'sessions');
    expect(piSessionDirs()).toHaveLength(1);
  });

  it('is named pi and detects only an existing sessions folder', async () => {
    const adapter = createPiAdapter();
    expect(adapter.name).toBe('pi');
    expect(await adapter.detect()).toBe(true);
    await rm(join(agentDir, 'sessions'), { recursive: true });
    expect(await adapter.detect()).toBe(false);
    process.env['PI_CODING_AGENT_SESSION_DIR'] = root;
    expect(await adapter.detect()).toBe(true);
  });

  it('counts an assistant message with exclusive input, and never adds reasoning to output', async () => {
    await sessionFile('a.jsonl', [header, assistant({ message: { usage: usage({ reasoning: 100 }) } })]);
    const result = await collect();
    expect(result.source).toBe('pi');
    expect(result.requestCount).toBe(1);
    expect(result.usage).toEqual([
      {
        date: '2026-10-03',
        model: 'gpt-5.1',
        pricingTier: 'standard',
        counts: { inputTokens: 12, outputTokens: 340, cacheCreationTokens: 800, cacheReadTokens: 50000, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('/Users/');
  });

  it('splits the cache write for Anthropic and Bedrock, and leaves it unknown elsewhere', async () => {
    await sessionFile('a.jsonl', [
      header,
      assistant({ message: { api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', responseId: 'msg_1', usage: usage({ cacheWrite: 800, cacheWrite1h: 300 }) } }),
      // An Anthropic request with no cacheWrite1h (an older file) has an unknown split.
      assistant({ message: { api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', responseId: 'msg_2' } }),
      // A Claude model behind a gateway that is not the Anthropic API is not trusted for the split.
      assistant({ message: { api: 'openai-completions', provider: 'openrouter', model: 'anthropic/claude-haiku-4-5', responseId: 'or_1', usage: usage({ cacheWrite1h: 10 }) } }),
    ]);
    const { usage: rows } = await collect();
    const sonnet = rows.filter((row) => row.model === 'claude-sonnet-4-5');
    expect(sonnet).toHaveLength(1);
    // 300 + 0 known, 500 + 0: the second request's null split adds as unknown only when both are null.
    expect(sonnet[0]!.counts).toMatchObject({ cacheCreationTokens: 1600, cacheCreation5mTokens: 500, cacheCreation1hTokens: 300 });
    const haiku = rows.find((row) => row.model === 'claude-haiku-4-5')!;
    expect(haiku.counts).toMatchObject({ cacheCreationTokens: 800, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
  });

  it('clamps a 1h write larger than the cache write', async () => {
    await sessionFile('a.jsonl', [
      assistant({ message: { api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: usage({ cacheWrite: 100, cacheWrite1h: 900 }) } }),
    ]);
    const { usage: rows } = await collect();
    expect(rows[0]!.counts).toMatchObject({ cacheCreation5mTokens: 0, cacheCreation1hTokens: 100 });
  });

  it('attributes the model the provider reported, canonicalised', async () => {
    await sessionFile('a.jsonl', [
      assistant({ message: { provider: 'amazon-bedrock', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', responseModel: 'claude-sonnet-4-5', responseId: 'b1' } }),
      assistant({ message: { provider: 'openrouter', model: 'anthropic/claude-opus-4.5', responseId: 'b2' } }),
    ]);
    const { usage: rows } = await collect();
    expect(rows.map((row) => row.model).sort()).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);
  });

  it('counts a fork once: the same responseId in a copied file merges, the first copy decides the day', async () => {
    const original = [header, assistant()];
    const fork = [{ ...header, id: 'fork', parentSession: '/x/a.jsonl' }, assistant({ id: 'b2c3d4e5' })];
    await sessionFile('a.jsonl', original);
    await sessionFile('b.jsonl', fork);
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.counts.outputTokens).toBe(340);
  });

  it('dedups requests without a responseId by timestamp, model and counts, and keeps distinct ones', async () => {
    const noId = (timestamp: number, output: number) => assistant({ message: { responseId: undefined, timestamp, usage: usage({ output }) } });
    const t = Date.parse('2026-10-03T10:00:00Z');
    await sessionFile('a.jsonl', [noId(t, 10), noId(t + 1000, 10), noId(t, 11)]);
    await sessionFile('b.jsonl', [noId(t, 10)]);
    expect((await collect()).requestCount).toBe(3);
  });

  it('does not treat the same responseId from two providers as one request', async () => {
    await sessionFile('a.jsonl', [
      assistant({ message: { provider: 'openai', responseId: 'same' } }),
      assistant({ message: { provider: 'google', model: 'gemini-2.5-pro', responseId: 'same' } }),
    ]);
    expect((await collect()).requestCount).toBe(2);
  });

  it('counts every branch of a tree, abandoned ones included', async () => {
    await sessionFile('a.jsonl', [
      header,
      assistant({ id: 'aaaa0001', message: { responseId: 'r1' } }),
      { ...assistant({ id: 'aaaa0002', message: { responseId: 'r2' } }), parentId: 'a1b2c3d4' },
    ]);
    expect((await collect()).requestCount).toBe(2);
  });

  it('counts usage entries of any kind with their own provider and model, and dedups their fork copies', async () => {
    const warm = { type: 'usage', id: 'f6g7h8i9', parentId: 'x', timestamp: '2026-10-04T08:00:00.000Z', kind: 'cache_warm', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: usage({ input: 0, output: 0, cacheRead: 50000, cacheWrite: 0, cacheWrite1h: 0 }) };
    await sessionFile('a.jsonl', [warm, { ...warm, kind: 'something_new', id: 'zzzzzzzz', timestamp: '2026-10-05T08:00:00.000Z' }]);
    await sessionFile('b.jsonl', [warm]);
    const { usage: rows, requestCount } = await collect();
    expect(requestCount).toBe(2);
    expect(rows.map((row) => row.date)).toEqual(['2026-10-04', '2026-10-05']);
    expect(rows[0]!.counts).toMatchObject({ inputTokens: 0, cacheReadTokens: 50000, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });
  });

  it('reports usage on compaction, branch summary and tool results as uncounted, because they name no model', async () => {
    const lines = [
      { type: 'compaction', id: 'c1', parentId: null, timestamp: '2026-10-03T15:00:00.000Z', summary: SECRET, usage: usage() },
      { type: 'branch_summary', id: 'c2', parentId: null, timestamp: '2026-10-03T15:01:00.000Z', summary: SECRET, usage: usage() },
      { type: 'message', id: 'c3', parentId: null, timestamp: '2026-10-03T15:02:00.000Z', message: { role: 'toolResult', content: [], usage: usage(), timestamp: 1 } },
      { type: 'compaction', id: 'c4', parentId: null, timestamp: '2026-10-03T15:03:00.000Z', summary: 'no usage' },
    ];
    await sessionFile('a.jsonl', [...lines, assistant()]);
    await sessionFile('b.jsonl', lines);
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.notes).toEqual(['skipped 3 pi usage record(s) with no model (compaction, branch summary or tool result summaries); their tokens are not counted']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('counts a missing cacheRead or cacheWrite as 0 and skips malformed records with a note', async () => {
    await sessionFile('a.jsonl', [
      '{ not json',
      assistant({ message: { responseId: 'old', usage: { input: 5, output: 7, totalTokens: 12 } } }),
      assistant({ message: { responseId: 'neg', usage: usage({ output: -1 }) } }),
      assistant({ message: { responseId: 'frac', usage: usage({ input: 1.5 }) } }),
      { ...assistant({ message: { responseId: 'badts', timestamp: 'x' } }), timestamp: 'not a date' },
      assistant({ message: { responseId: 'zero', usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) } }),
      { type: 'message', message: 'junk' },
      { type: 'usage', provider: 'anthropic', usage: usage() },
    ]);
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(result.notes).toEqual(['skipped 4 pi record(s) with missing or invalid token counts, model or timestamp']);
  });

  it('falls back to the entry timestamp when the message carries none', async () => {
    await sessionFile('a.jsonl', [assistant({ message: { timestamp: undefined } })]);
    expect((await collect()).usage[0]!.date).toBe('2026-10-03');
  });

  it('filters by since on the request time and skips files untouched since then', async () => {
    await sessionFile('new.jsonl', [
      assistant({ message: { responseId: 'old', timestamp: Date.parse('2026-09-01T00:00:00Z') } }),
      assistant({ message: { responseId: 'new', timestamp: Date.parse('2026-10-03T00:00:00Z') } }),
    ]);
    await sessionFile('stale.jsonl', [assistant({ message: { responseId: 'stale', timestamp: Date.parse('2026-10-03T00:00:00Z') } })]);
    await utimes(join(agentDir, 'sessions', '--proj--', 'stale.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
    const result = await collect(new Date('2026-10-01T00:00:00Z'));
    expect(result.requestCount).toBe(1);
    expect(result.usage.map((row) => row.date)).toEqual(['2026-10-03']);
  });

  it('reads sessions from the session folder override as well as the agent folder', async () => {
    const other = join(root, 'other-sessions');
    await mkdir(other);
    await sessionFile('c.jsonl', [assistant({ message: { responseId: 'elsewhere' } })], other);
    await sessionFile('a.jsonl', [assistant({ message: { responseId: 'home' } })]);
    process.env['PI_CODING_AGENT_SESSION_DIR'] = other;
    expect((await collect()).requestCount).toBe(2);
  });

  it('buckets long-context requests at their tier', async () => {
    await sessionFile('a.jsonl', [assistant({ message: { model: 'gpt-5.1', usage: usage({ input: 300000 }) } })]);
    expect((await collect()).usage[0]!.pricingTier).toBe('long-context');
  });
});
