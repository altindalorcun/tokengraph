import { describe, expect, it } from 'vitest';
import { addClassicTask, type ClassicTask } from '../src/adapters/cline/classic.js';
import { emptyClineDiagnostics, normalizeSdk } from '../src/adapters/cline/normalize.js';
import { RequestBuckets } from '../src/adapters/request-buckets.js';

/** One ui_messages.json usage entry, per the task brief's helper. */
function apiReq(ts: number, usage: Record<string, number>, modelInfo?: Record<string, string>, say = 'api_req_started') {
  return {
    ts,
    type: 'say',
    say,
    text: JSON.stringify({ request: 'secret prompt', ...usage, cost: 0.01 }),
    ...(modelInfo ? { modelInfo } : {}),
  };
}

function task(taskId: string, messages: unknown[], metadata: unknown = null): ClassicTask {
  return { taskId, messages, metadata };
}

const T1 = Date.UTC(2026, 8, 27, 10, 0, 0);
const UTC = { timeZone: 'UTC' };

describe('addClassicTask', () => {
  it('an Anthropic row: exclusive rule keeps tokensIn as-is; cache fields mapped through', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t1', [
        apiReq(T1, { tokensIn: 812, tokensOut: 356, cacheWrites: 2104, cacheReads: 48211 }, {
          providerId: 'anthropic',
          modelId: 'claude-sonnet-4-5-20250929',
        }),
      ]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.toUsage()).toEqual([
      {
        date: '2026-09-27',
        model: 'claude-sonnet-4-5-20250929',
        pricingTier: 'standard',
        counts: {
          inputTokens: 812,
          outputTokens: 356,
          cacheCreationTokens: 2104,
          cacheReadTokens: 48211,
          cacheCreation5mTokens: null,
          cacheCreation1hTokens: null,
        },
      },
    ]);
    expect(diagnostics.clamped).toBe(0);
  });

  it('an OpenAI Compatible row: cache-inclusive rule subtracts cacheReads from tokensIn', () => {
    const buckets = new RequestBuckets();
    addClassicTask(
      task('t2', [
        apiReq(T1, { tokensIn: 10000, tokensOut: 100, cacheWrites: 0, cacheReads: 8000 }, {
          providerId: 'openai',
          modelId: 'openai-compatible-model',
        }),
      ]),
      buckets,
      emptyClineDiagnostics(),
      UTC,
    );
    expect(buckets.toUsage()[0].counts.inputTokens).toBe(2000);
  });

  it('an ollama row with no cache fields: inputTokens equals tokensIn', () => {
    const buckets = new RequestBuckets();
    addClassicTask(
      task('t3', [apiReq(T1, { tokensIn: 500, tokensOut: 50 }, { providerId: 'ollama', modelId: 'llama3' })]),
      buckets,
      emptyClineDiagnostics(),
      UTC,
    );
    expect(buckets.toUsage()[0].counts.inputTokens).toBe(500);
  });

  it('an unknown provider: cache larger than input means the row is exclusive, so tokensIn is the fresh input', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t4', [
        apiReq(T1, { tokensIn: 100, tokensOut: 1, cacheWrites: 0, cacheReads: 150 }, {
          providerId: 'some-new-vendor',
          modelId: 'x',
        }),
      ]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.toUsage()[0].counts.inputTokens).toBe(100);
    expect(diagnostics.exclusiveDetected).toBe(1);
    expect(diagnostics.clamped).toBe(0);
  });

  it('no modelInfo: model comes from task_metadata.model_usage, taking the entry at or before the request', () => {
    const buckets = new RequestBuckets();
    const metadata = {
      model_usage: [
        { ts: 500, model_provider_id: 'anthropic', model_id: 'model-a' },
        { ts: 1500, model_provider_id: 'anthropic', model_id: 'model-b' },
      ],
    };
    addClassicTask(
      task('t5', [apiReq(1000, { tokensIn: 300, tokensOut: 10, cacheWrites: 0, cacheReads: 0 })], metadata),
      buckets,
      emptyClineDiagnostics(),
      UTC,
    );
    expect(buckets.toUsage()[0].model).toBe('model-a');
  });

  it('no modelInfo and no metadata: model is unknown, cache-inclusive rule applies', () => {
    const buckets = new RequestBuckets();
    addClassicTask(
      task('t6', [apiReq(T1, { tokensIn: 500, tokensOut: 10, cacheWrites: 50, cacheReads: 100 })]),
      buckets,
      emptyClineDiagnostics(),
      UTC,
    );
    const usage = buckets.toUsage()[0];
    expect(usage.model).toBe('unknown');
    expect(usage.counts.inputTokens).toBe(350); // 500 - 100 - 50, proving the inclusive (not exclusive) rule ran
  });

  it('skips claude-code and bedrock-estimated providers; counts a Claude model on Bedrock', () => {
    const claudeCodeBuckets = new RequestBuckets();
    const claudeCodeDiagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t7a', [
        apiReq(T1, { tokensIn: 100, tokensOut: 10, cacheWrites: 0, cacheReads: 0 }, {
          providerId: 'claude-code',
          modelId: 'claude-sonnet-4-5',
        }),
      ]),
      claudeCodeBuckets,
      claudeCodeDiagnostics,
      UTC,
    );
    expect(claudeCodeBuckets.size).toBe(0);
    expect(claudeCodeDiagnostics.skippedClaudeCode).toBe(1);

    const estimatedBuckets = new RequestBuckets();
    const estimatedDiagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t7b', [
        apiReq(T1, { tokensIn: 100, tokensOut: 10, cacheWrites: 0, cacheReads: 0 }, {
          providerId: 'bedrock',
          modelId: 'deepseek.r1-v1:0',
        }),
      ]),
      estimatedBuckets,
      estimatedDiagnostics,
      UTC,
    );
    expect(estimatedBuckets.size).toBe(0);
    expect(estimatedDiagnostics.skippedEstimated).toBe(1);

    const bedrockClaudeBuckets = new RequestBuckets();
    addClassicTask(
      task('t7c', [
        apiReq(T1, { tokensIn: 100, tokensOut: 10, cacheWrites: 0, cacheReads: 0 }, {
          providerId: 'bedrock',
          modelId: 'us.anthropic.claude-opus-4-7',
        }),
      ]),
      bedrockClaudeBuckets,
      emptyClineDiagnostics(),
      UTC,
    );
    expect(bedrockClaudeBuckets.toUsage()[0].model).toBe('claude-opus-4-7');
  });

  it('always skips a bedrock subagent_usage row as estimated, even with a Claude parent model', () => {
    // The subagent's own model can be overridden mid-group (SubagentBuilder.applyModelOverride),
    // so the parent task's Claude model on the row does not prove the subagent itself ran Claude.
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t7d', [
        apiReq(
          T1,
          { tokensIn: 100, tokensOut: 10, cacheWrites: 0, cacheReads: 0 },
          { providerId: 'bedrock', modelId: 'us.anthropic.claude-opus-4-7' },
          'subagent_usage',
        ),
      ]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.skippedEstimated).toBe(1);
  });

  it('still counts a non-bedrock subagent_usage row, with the model forced to unknown', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t7e', [
        apiReq(
          T1,
          { tokensIn: 100, tokensOut: 10, cacheWrites: 0, cacheReads: 0 },
          { providerId: 'anthropic', modelId: 'claude-opus-4-7' },
          'subagent_usage',
        ),
      ]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(diagnostics.skippedEstimated).toBe(0);
    const usage = buckets.toUsage()[0];
    expect(usage.model).toBe('unknown');
    expect(usage.counts.inputTokens).toBe(100);
  });

  it('ignores deleted_api_reqs, all-zero rows, and rows with malformed JSON text', () => {
    const buckets = new RequestBuckets();
    const deletedRow = apiReq(T1, { tokensIn: 999, tokensOut: 999, cacheWrites: 0, cacheReads: 0 }, undefined, 'deleted_api_reqs');
    const zeroRow = apiReq(T1 + 1, { tokensIn: 0, tokensOut: 0, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' });
    const malformedRow = { ts: T1 + 2, type: 'say', say: 'api_req_started', text: 'not json' };
    addClassicTask(task('t8', [deletedRow, zeroRow, malformedRow]), buckets, emptyClineDiagnostics(), UTC);
    expect(buckets.size).toBe(0);
  });

  it('counts a subagent_usage row with the model forced to unknown', () => {
    const buckets = new RequestBuckets();
    addClassicTask(
      task('t9', [
        apiReq(T1, { tokensIn: 200, tokensOut: 20, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' }, 'subagent_usage'),
      ]),
      buckets,
      emptyClineDiagnostics(),
      UTC,
    );
    const usage = buckets.toUsage()[0];
    expect(usage.model).toBe('unknown');
    expect(usage.counts.inputTokens).toBe(200); // provider (anthropic, exclusive) is still trusted
  });

  it('counts the same task once when added twice (two duplicate roots)', () => {
    const buckets = new RequestBuckets();
    // Two independently built message arrays (as if read from two different root directories),
    // not the same array reference, so this actually exercises RequestBuckets's dedup-by-key
    // rather than just re-iterating one array.
    const usage = { tokensIn: 400, tokensOut: 40, cacheWrites: 0, cacheReads: 0 };
    const modelInfo = { providerId: 'anthropic', modelId: 'm' };
    addClassicTask(task('t10', [apiReq(T1, usage, modelInfo)]), buckets, emptyClineDiagnostics(), UTC);
    addClassicTask(task('t10', [apiReq(T1, usage, modelInfo)]), buckets, emptyClineDiagnostics(), UTC);
    expect(buckets.size).toBe(1);
    expect(buckets.toUsage()[0].counts.inputTokens).toBe(400);
  });

  it('applies the since filter and assigns the day per the given time zone', () => {
    const before = apiReq(1000, { tokensIn: 1, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' });
    const after = apiReq(T1, { tokensIn: 2, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' });
    const buckets = new RequestBuckets();
    addClassicTask(task('t11', [before, after]), buckets, emptyClineDiagnostics(), { since: new Date(T1 - 1), timeZone: 'UTC' });
    expect(buckets.size).toBe(1);
    expect(buckets.toUsage()[0].counts.inputTokens).toBe(2);

    // 2026-09-27T02:00:00Z is still 2026-09-26 in America/New_York (UTC-4 under DST).
    const nearMidnight = Date.UTC(2026, 8, 27, 2, 0, 0);
    const tzUtcBuckets = new RequestBuckets();
    addClassicTask(
      task('t12', [apiReq(nearMidnight, { tokensIn: 1, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' })]),
      tzUtcBuckets,
      emptyClineDiagnostics(),
      { timeZone: 'UTC' },
    );
    expect(tzUtcBuckets.toUsage()[0].date).toBe('2026-09-27');

    const tzNyBuckets = new RequestBuckets();
    addClassicTask(
      task('t13', [apiReq(nearMidnight, { tokensIn: 1, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' })]),
      tzNyBuckets,
      emptyClineDiagnostics(),
      { timeZone: 'America/New_York' },
    );
    expect(tzNyBuckets.toUsage()[0].date).toBe('2026-09-26');
  });

  it('an out-of-range ts (finite but unparseable as a Date) is skipped and counted as malformed, never thrown', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    const row = apiReq(1e20, { tokensIn: 1, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' });
    expect(() => addClassicTask(task('t17', [row]), buckets, diagnostics, UTC)).not.toThrow();
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('skips an entry with a non-integer counter as malformed, rather than truncating it', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t18', [apiReq(T1, { tokensIn: 1.5, tokensOut: 10, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' })]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('skips an entry with a negative counter as malformed, rather than clamping it', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addClassicTask(
      task('t14', [
        apiReq(T1, { tokensIn: -5, tokensOut: 10, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' }),
      ]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('treats a bare JSON array as the text payload as malformed, not as silent zero counts', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    const arrayPayload = { type: 'say', say: 'api_req_started', ts: T1, text: JSON.stringify([1, 2, 3]) };
    addClassicTask(task('t16', [arrayPayload]), buckets, diagnostics, UTC);
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('counts every kind of malformed entry in diagnostics.malformedEntries, but not the legitimate skips', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    const badTs = { type: 'say', say: 'api_req_started', ts: Number.NaN, text: JSON.stringify({ tokensIn: 1 }) };
    const badText = { type: 'say', say: 'api_req_started', ts: T1, text: 42 };
    const badJson = { type: 'say', say: 'api_req_started', ts: T1, text: 'not json' };
    const badPayload = { type: 'say', say: 'api_req_started', ts: T1, text: JSON.stringify(null) };
    const negativeCounter = apiReq(T1, { tokensIn: -1, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' });
    // Legitimate skips that must NOT bump malformedEntries.
    const allZero = apiReq(T1, { tokensIn: 0, tokensOut: 0, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'm' });
    const deleted = apiReq(T1, { tokensIn: 999, tokensOut: 999, cacheWrites: 0, cacheReads: 0 }, undefined, 'deleted_api_reqs');
    const plainChat = { type: 'say', say: 'text', ts: T1 };

    addClassicTask(
      task('t15', [badTs, badText, badJson, badPayload, negativeCounter, allZero, deleted, plainChat]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(5);
  });
});

describe('normalizeSdk', () => {
  it('subtracts both cache subtotals from inputTokens unconditionally', () => {
    const diagnostics = emptyClineDiagnostics();
    const counts = normalizeSdk({ inputTokens: 52310, outputTokens: 412, cacheReadTokens: 48211, cacheWriteTokens: 3287 }, diagnostics);
    expect(counts).toEqual({
      inputTokens: 812,
      outputTokens: 412,
      cacheCreationTokens: 3287,
      cacheReadTokens: 48211,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    });
    expect(diagnostics.clamped).toBe(0);
  });
});
