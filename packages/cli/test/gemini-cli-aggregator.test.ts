import { describe, expect, it } from 'vitest';
import { GeminiUsageAggregator } from '../src/adapters/gemini-cli/aggregator.js';

/** One gemini-shaped message, per the task brief's helper. */
function gemini(id: string, tokens: Record<string, number> | undefined, overrides: Record<string, unknown> = {}) {
  return {
    id,
    timestamp: '2026-09-27T10:00:00.000Z',
    type: 'gemini',
    content: 'secret text',
    model: 'gemini-2.5-pro',
    ...(tokens ? { tokens } : {}),
    ...overrides,
  };
}

describe('GeminiUsageAggregator normalisation', () => {
  it('normalises the note\'s example message', () => {
    const aggregator = new GeminiUsageAggregator();
    aggregator.addRecord(gemini('a', { input: 15327, output: 23, cached: 11526, thoughts: 919, tool: 7, total: 16276 }));
    const result = aggregator.result();
    expect(result.source).toBe('gemini-cli');
    expect(result.requestCount).toBe(1);
    expect(result.usage).toEqual([
      {
        date: '2026-09-27',
        model: 'gemini-2.5-pro',
        pricingTier: 'standard',
        counts: {
          inputTokens: 3808,
          outputTokens: 942,
          cacheCreationTokens: 0,
          cacheReadTokens: 11526,
          cacheCreation5mTokens: null,
          cacheCreation1hTokens: null,
        },
      },
    ]);
  });

  it('counts the same id appended twice in one file once', () => {
    const aggregator = new GeminiUsageAggregator();
    const tokens = { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 };
    aggregator.addRecord(gemini('a', tokens));
    aggregator.addRecord(gemini('a', tokens, { toolCalls: [{ id: 'read_file__x', name: 'read_file', status: 'success' }] }));
    expect(aggregator.result().requestCount).toBe(1);
  });

  it('counts the same id once whether it comes from a JSONL record or a legacy document', () => {
    const aggregator = new GeminiUsageAggregator();
    const tokens = { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 };
    aggregator.addRecord(gemini('a', tokens));
    aggregator.addDocument({ messages: [gemini('a', tokens)] });
    expect(aggregator.result().requestCount).toBe(1);
  });

  it('keeps the tokens from a later copy when an earlier copy of the same id had none', () => {
    const aggregator = new GeminiUsageAggregator();
    const tokens = { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 };
    aggregator.addRecord(gemini('a', undefined));
    aggregator.addRecord(gemini('a', tokens));
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts.inputTokens).toBe(100);
  });

  it('counts a $set.messages candidate and ignores $rewindTo', () => {
    const aggregator = new GeminiUsageAggregator();
    const tokens = { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 };
    aggregator.addRecord(gemini('a', tokens));
    aggregator.addRecord({ $set: { messages: [gemini('b', tokens)] } });
    aggregator.addRecord({ $rewindTo: 'a' });
    expect(aggregator.result().requestCount).toBe(2);
  });

  it('ignores a type: user message even if it carries tokens', () => {
    const aggregator = new GeminiUsageAggregator();
    aggregator.addRecord({ id: 'c', timestamp: '2026-09-27T10:00:00.000Z', type: 'user', tokens: { input: 1, output: 1 } });
    expect(aggregator.result().requestCount).toBe(0);
  });

  it('defaults missing thoughts/tool to 0, and flags a message missing input as malformed without counting it', () => {
    const aggregator = new GeminiUsageAggregator();
    aggregator.addRecord(gemini('a', { input: 100, output: 20, cached: 0 }));
    aggregator.addRecord(gemini('b', { output: 20, cached: 0 }));
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(aggregator.diagnostics().malformedMessages).toBe(1);
  });

  it('clamps fresh input to 0 (keeping tool tokens) when cached exceeds input', () => {
    const aggregator = new GeminiUsageAggregator();
    aggregator.addRecord(gemini('a', { input: 10, output: 5, cached: 50, tool: 3 }));
    const result = aggregator.result();
    expect(result.usage[0]!.counts.inputTokens).toBe(3);
    expect(aggregator.diagnostics().clampedMessages).toBe(1);
  });

  it('flags a present negative or non-integer required/optional counter as malformed', () => {
    const negativeInput = new GeminiUsageAggregator();
    negativeInput.addRecord(gemini('a', { input: -1, output: 20 }));
    expect(negativeInput.result().requestCount).toBe(0);
    expect(negativeInput.diagnostics().malformedMessages).toBe(1);

    const fractionalCached = new GeminiUsageAggregator();
    fractionalCached.addRecord(gemini('b', { input: 100, output: 20, cached: 1.5 }));
    expect(fractionalCached.result().requestCount).toBe(0);
    expect(fractionalCached.diagnostics().malformedMessages).toBe(1);
  });

  it('does not keep a malformed diagnostic once a later copy of the same id is valid', () => {
    const aggregator = new GeminiUsageAggregator();
    aggregator.addRecord(gemini('a', { output: 20 })); // missing input: malformed
    aggregator.addRecord(gemini('a', { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 }));
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(aggregator.diagnostics().malformedMessages).toBe(0);
  });

  it('still counts a message whose total is off by one, and flags the mismatch', () => {
    const aggregator = new GeminiUsageAggregator();
    aggregator.addRecord(gemini('a', { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 121 }));
    const result = aggregator.result();
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(aggregator.diagnostics().totalMismatches).toBe(1);
  });

  it('produces two usage rows for two models in one session', () => {
    const aggregator = new GeminiUsageAggregator();
    const tokens = { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 };
    aggregator.addRecord(gemini('a', tokens, { model: 'gemini-2.5-pro' }));
    aggregator.addRecord(gemini('b', tokens, { model: 'gemini-2.5-flash' }));
    const result = aggregator.result();
    expect(result.usage.map((u) => u.model).sort()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('excludes messages before since and buckets by the given time zone', () => {
    const tokens = { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 };
    const aggregator = new GeminiUsageAggregator({ since: new Date('2026-09-10T00:00:00.000Z'), timeZone: 'Europe/Istanbul' });
    aggregator.addRecord(gemini('old', tokens, { timestamp: '2026-09-01T00:00:00.000Z' }));
    aggregator.addRecord(gemini('a', tokens, { timestamp: '2026-09-26T22:30:00.000Z' }));
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.date).toBe('2026-09-27');
  });

  it('uses unknown as the model when the message has none', () => {
    const aggregator = new GeminiUsageAggregator();
    const tokens = { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 };
    aggregator.addRecord(gemini('a', tokens, { model: undefined }));
    expect(aggregator.result().usage[0]!.model).toBe('unknown');
  });
});

describe('GeminiUsageAggregator diagnostics', () => {
  it('reports unreadable files noted from outside the aggregator', () => {
    const aggregator = new GeminiUsageAggregator();
    aggregator.noteUnreadableFile();
    aggregator.noteUnreadableFile();
    expect(aggregator.diagnostics().unreadableFiles).toBe(2);
  });
});
