import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addClassicTask } from '../src/adapters/cline/classic.js';
import { createClineAdapter } from '../src/adapters/cline/index.js';
import { emptyClineDiagnostics } from '../src/adapters/cline/normalize.js';
import { addSdkMessages, learnExclusiveModels } from '../src/adapters/cline/sdk.js';
import { RequestBuckets } from '../src/adapters/request-buckets.js';

const UTC = { timeZone: 'UTC' };
const T = Date.UTC(2026, 8, 27, 10, 0, 0);

function row(id: string, provider: string, modelId: string, inputTokens: number, cacheReadTokens: number, cacheWriteTokens = 0) {
  return {
    id,
    role: 'assistant',
    ts: T,
    modelInfo: { id: modelId, provider },
    metrics: { inputTokens, outputTokens: 10, cacheReadTokens, cacheWriteTokens },
    content: [{ type: 'text', text: 'reply' }],
  };
}

function sdkInput(provider: string, modelId: string, input: number, cr: number, cw = 0) {
  const buckets = new RequestBuckets();
  const diagnostics = emptyClineDiagnostics();
  addSdkMessages({ document: { messages: [row('m1', provider, modelId, input, cr, cw)] }, manifest: null }, buckets, diagnostics, UTC);
  return { counts: buckets.toUsage()[0]!.counts, diagnostics };
}

describe('Cline SDK cache-exclusive rows', () => {
  it('inclusive row is unchanged', () => {
    const { counts, diagnostics } = sdkInput('anthropic', 'claude-sonnet-4-6', 52310, 48211, 3287);
    expect(counts.inputTokens).toBe(812);
    expect(diagnostics.exclusiveDetected).toBe(0);
  });

  it('equality (cache == input) is inclusive with 0 fresh input', () => {
    const { counts, diagnostics } = sdkInput('cline', 'deepseek/deepseek-v4-flash', 1000, 600, 400);
    expect(counts.inputTokens).toBe(0);
    expect(diagnostics.exclusiveDetected).toBe(0);
  });

  it('real minimax row with cache > input keeps its reported input', () => {
    const { counts, diagnostics } = sdkInput('cline', 'minimax/minimax-m2.5', 45865, 88671);
    expect(counts.inputTokens).toBe(45865);
    expect(counts.cacheReadTokens).toBe(88671);
    expect(diagnostics.exclusiveDetected).toBe(1);
    expect(diagnostics.clamped).toBe(0);
  });

  it('real minimax row with cache < input is caught by the seed', () => {
    const { counts, diagnostics } = sdkInput('cline', 'minimax/minimax-m2.5', 8281, 6711);
    expect(counts.inputTokens).toBe(8281);
    expect(diagnostics.exclusiveDetected).toBe(1);
    expect(sdkInput('cline-pass', 'minimax/minimax-m2.5', 8281, 6711).counts.inputTokens).toBe(8281);
  });

  it('the seed is gated on the gateway providers and the minimax/ prefix', () => {
    expect(sdkInput('anthropic', 'minimax/minimax-m2.5', 8281, 6711).counts.inputTokens).toBe(1570);
    expect(sdkInput('cline-free', 'minimax/minimax-m2.5', 8281, 6711).counts.inputTokens).toBe(1570);
    expect(sdkInput('cline', 'cline-free/minimax/x', 8281, 6711).counts.inputTokens).toBe(1570);
    expect(sdkInput('cline', 'poolside/laguna-s-2.1:free', 8281, 6711).counts.inputTokens).toBe(1570);
  });

  it('a deepseek inclusive row under provider cline is unchanged', () => {
    const { counts, diagnostics } = sdkInput('cline', 'deepseek/deepseek-v4-flash', 140535, 140416);
    expect(counts.inputTokens).toBe(119);
    expect(diagnostics.exclusiveDetected).toBe(0);
  });

  it('no cache: same under both readings', () => {
    expect(sdkInput('cline', 'x/y', 47937, 0).counts.inputTokens).toBe(47937);
  });

  it('a cache-write-only violation is exclusive', () => {
    const { counts } = sdkInput('openai', 'gpt-x', 100, 0, 150);
    expect(counts.inputTokens).toBe(100);
  });

  it('model rule: a violating row makes the same model exclusive for its non-violating rows, and only that model', () => {
    const learned = new Set<string>();
    learnExclusiveModels({ messages: [row('a', 'cline', 'foo/bar', 9820, 10743)] }, learned);
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(
      { document: { messages: [row('b', 'cline', 'foo/bar', 8281, 6711), row('c', 'cline', 'other/model', 8281, 6711)] }, manifest: null },
      buckets,
      diagnostics,
      UTC,
      learned,
    );
    const byModel = Object.fromEntries(buckets.toUsage().map((u) => [u.model, u.counts.inputTokens]));
    expect(byModel['foo/bar']).toBe(8281);
    expect(byModel['other/model']).toBe(1570);
    expect(diagnostics.exclusiveDetected).toBe(1);
  });
});

describe('Cline classic cache-exclusive rows', () => {
  function classic(providerId: string | null, usage: Record<string, number>) {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    const modelInfo = providerId ? { providerId, modelId: 'm' } : undefined;
    addClassicTask(
      {
        taskId: 't',
        metadata: null,
        messages: [{ ts: T, type: 'say', say: 'api_req_started', text: JSON.stringify(usage), ...(modelInfo ? { modelInfo } : {}) }],
      },
      buckets,
      diagnostics,
      UTC,
    );
    return { input: buckets.toUsage()[0]!.counts.inputTokens, diagnostics };
  }
  const shape = { tokensIn: 100, tokensOut: 1, cacheWrites: 0, cacheReads: 200 };

  it('a listed-inclusive provider with cache > input keeps tokensIn', () => {
    const { input, diagnostics } = classic('openai', shape);
    expect(input).toBe(100);
    expect(diagnostics.exclusiveDetected).toBe(1);
    expect(diagnostics.clamped).toBe(0);
  });

  it('an exclusive provider is unchanged and an unknown provider follows the same row rule', () => {
    expect(classic('anthropic', shape).input).toBe(100);
    expect(classic('anthropic', shape).diagnostics.exclusiveDetected).toBe(0);
    expect(classic(null, shape).input).toBe(100);
  });

  it('a normal inclusive classic row still subtracts', () => {
    expect(classic('openai', { tokensIn: 1000, tokensOut: 1, cacheWrites: 100, cacheReads: 300 }).input).toBe(600);
  });
});

describe('createClineAdapter exclusive model rule across files', () => {
  let dataDir: string;
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ['HOME', 'USERPROFILE', 'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_SESSION_DATA_DIR'] as const;

  beforeEach(async () => {
    for (const k of keys) saved[k] = process.env[k];
    home = await mkdtemp(join(tmpdir(), 'cline-home-'));
    dataDir = await mkdtemp(join(tmpdir(), 'cline-data-'));
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    delete process.env['CLINE_DIR'];
    delete process.env['CLINE_SESSION_DATA_DIR'];
    process.env['CLINE_DATA_DIR'] = dataDir;
  });

  afterEach(async () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('a violating row in one session makes the same model exclusive in another, with a note', async () => {
    const ts = Date.now() - 3_600_000;
    const make = (id: string, input: number, cr: number) => ({ ...row(id, 'cline', 'foo/bar', input, cr), ts });
    // "a" sorts first, so its non-violating row is read before the violating one in session "b".
    for (const [session, msgs] of [
      ['a', [make('m1', 8281, 6711)]],
      ['b', [make('m2', 9820, 10743)]],
    ] as const) {
      const dir = join(dataDir, 'sessions', session);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${session}.messages.json`), JSON.stringify({ version: 1, messages: msgs }));
    }
    const result = await createClineAdapter({ timeZone: 'UTC' }).collect(new Date(Date.now() - 86_400_000));
    expect(result.usage.reduce((sum, u) => sum + u.counts.inputTokens, 0)).toBe(8281 + 9820);
    expect(result.notes?.some((n) => n.includes('excluding cache'))).toBe(true);
  });
});
