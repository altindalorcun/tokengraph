import { describe, expect, it } from 'vitest';
import { CodexUsageAggregator } from '../src/adapters/codex/aggregator.js';

interface Usage {
  input?: number;
  cached?: number;
  cacheWrite?: number;
  output?: number;
}

function usageFields({ input = 1000, cached = 600, cacheWrite = 100, output = 50 }: Usage = {}) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 10,
    total_tokens: input + output,
  };
}

const T = '2026-09-22T12:00:00.000Z';

function turnContext(turnId: string, model: string, timestamp = T): string {
  return JSON.stringify({ timestamp, type: 'turn_context', payload: { turn_id: turnId, model, cwd: '/secret/path' } });
}

function record(responseId: string, turnId: string, usage: Usage = {}, timestamp = T): string {
  return JSON.stringify({
    timestamp,
    type: 'token_usage_record',
    payload: { response_id: responseId, turn_id: turnId, usage: usageFields(usage) },
  });
}

function tokenCount(usage: Usage = {}, timestamp = T): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    // total_token_usage mirrors last_token_usage here so distinct calls carry a distinct total
    // (used to recognise an unchanged rate-limit refresh) while identical calls collide on purpose.
    payload: { type: 'token_count', info: { last_token_usage: usageFields(usage), total_token_usage: usageFields(usage) } },
  });
}

function serviceTier(tier: string): string {
  return JSON.stringify({
    timestamp: T,
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', service_tier: tier } },
  });
}

function collect(files: string[][], options = {}) {
  const aggregator = new CodexUsageAggregator({ timeZone: 'UTC', ...options });
  for (const lines of files) {
    aggregator.beginFile();
    for (const l of lines) aggregator.addLine(l);
    aggregator.endFile();
  }
  return { result: aggregator.result(), diagnostics: aggregator.diagnostics() };
}

describe('CodexUsageAggregator normalisation', () => {
  it('splits cache reads and writes out of input and never double counts reasoning', () => {
    const { result } = collect([[turnContext('t1', 'gpt-6-luna'), record('r1', 't1')]]);
    expect(result.source).toBe('codex-cli');
    expect(result.usage).toEqual([
      {
        date: '2026-09-22',
        model: 'gpt-6-luna',
        pricingTier: 'standard',
        counts: {
          inputTokens: 300,
          outputTokens: 50,
          cacheCreationTokens: 100,
          cacheReadTokens: 600,
          cacheCreation5mTokens: null,
          cacheCreation1hTokens: null,
        },
      },
    ]);
  });

  it('sums a day and keeps the cache split unknown rather than zero', () => {
    const { result } = collect([[turnContext('t1', 'gpt-6-luna'), record('r1', 't1'), record('r2', 't1')]]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 600, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
    expect(result.requestCount).toBe(2);
  });

  it('clamps a negative uncached input to zero and reports it', () => {
    const { result, diagnostics } = collect([[turnContext('t1', 'm'), record('r1', 't1', { input: 100, cached: 90, cacheWrite: 20 })]]);
    expect(result.usage[0]!.counts.inputTokens).toBe(0);
    expect(diagnostics.clampedEvents).toBe(1);
  });

  it('treats missing cache counters as zero but skips a record without input or output', () => {
    const noCache = JSON.stringify({
      timestamp: T,
      type: 'token_usage_record',
      payload: { response_id: 'r1', turn_id: 't1', usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const noOutput = JSON.stringify({
      timestamp: T,
      type: 'token_usage_record',
      payload: { response_id: 'r2', turn_id: 't1', usage: { input_tokens: 10 } },
    });
    const { result, diagnostics } = collect([[turnContext('t1', 'm'), noCache, noOutput]]);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });
    expect(diagnostics.malformedEvents).toBe(1);
  });

  it('ignores lines that are not JSON or not usage', () => {
    const { result } = collect([['not json', '', JSON.stringify({ type: 'response_item', payload: {} }), turnContext('t1', 'm'), record('r1', 't1')]]);
    expect(result.usage).toHaveLength(1);
  });
});

describe('CodexUsageAggregator models', () => {
  it('takes the model from the turn the record belongs to', () => {
    const { result } = collect([
      [turnContext('t1', 'gpt-6-luna'), record('r1', 't1'), turnContext('t2', 'gpt-6-sol'), record('r2', 't2'), record('r3', 't1')],
    ]);
    expect(result.usage.map((u) => [u.model, u.counts.outputTokens])).toEqual([
      ['gpt-6-luna', 100],
      ['gpt-6-sol', 50],
    ]);
  });

  it('resolves the model even when the record comes before its turn_context line', () => {
    const { result } = collect([[record('r1', 't1'), turnContext('t1', 'gpt-6-luna')]]);
    expect(result.usage[0]!.model).toBe('gpt-6-luna');
  });

  it('uses unknown rather than guessing when the turn has no context', () => {
    const { result } = collect([[turnContext('t1', 'gpt-6-luna'), record('r1', 'other-turn')]]);
    expect(result.usage[0]!.model).toBe('unknown');
  });

  it('does not carry turn models from one file into the next', () => {
    const { result } = collect([[turnContext('t1', 'gpt-6-luna')], [record('r1', 't1')]]);
    expect(result.usage[0]!.model).toBe('unknown');
  });
});

describe('CodexUsageAggregator deduplication and fallback', () => {
  it('dedups the same response across files (forked or resumed sessions)', () => {
    const { result } = collect([
      [turnContext('t1', 'm'), record('r1', 't1')],
      [turnContext('t1', 'm'), record('r1', 't1'), record('r2', 't1')],
    ]);
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]!.counts.outputTokens).toBe(100);
  });

  it('ignores token_count events in a file that has token_usage_record lines', () => {
    const { result, diagnostics } = collect([[turnContext('t1', 'm'), tokenCount(), record('r1', 't1'), tokenCount()]]);
    expect(result.usage[0]!.counts.outputTokens).toBe(50);
    expect(diagnostics.fallbackEvents).toBe(0);
  });

  it('falls back to token_count in a file without records, with the latest turn model', () => {
    const { result, diagnostics } = collect([
      [turnContext('t1', 'gpt-5.4'), tokenCount(), turnContext('t2', 'gpt-6-luna'), tokenCount({ output: 7 })],
    ]);
    expect(result.usage.map((u) => [u.model, u.counts.outputTokens])).toEqual([
      ['gpt-5.4', 50],
      ['gpt-6-luna', 7],
    ]);
    expect(diagnostics.fallbackEvents).toBe(2);
    expect(result.requestCount).toBe(2);
  });

  it('skips a token_count whose info is null (a rate-limit-only update)', () => {
    const nullInfo = JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: null } });
    const { result, diagnostics } = collect([[turnContext('t1', 'm'), nullInfo]]);
    expect(result.usage).toEqual([]);
    expect(diagnostics.malformedEvents).toBe(0);
  });

  it('prefers a later file that resolves the model over an earlier copy that could not', () => {
    const { result } = collect([
      [record('r1', 't1')],
      [turnContext('t1', 'gpt-6-luna'), record('r1', 't1')],
    ]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.model).toBe('gpt-6-luna');
    expect(result.requestCount).toBe(1);
  });

  it('keeps the first copy once it has resolved a model, even if a later copy cannot', () => {
    const { result } = collect([
      [turnContext('t1', 'gpt-6-luna'), record('r1', 't1')],
      [record('r1', 't1')],
    ]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.model).toBe('gpt-6-luna');
    expect(result.requestCount).toBe(1);
  });

  it('picks the earliest-instant copy among two that both resolve a model, file order early-then-late', () => {
    const early = [
      turnContext('t1', 'gpt-6-luna', '2026-09-22T10:00:00.000Z'),
      record('r1', 't1', {}, '2026-09-22T10:00:00.000Z'),
    ];
    const late = [
      turnContext('t1', 'gpt-6-sol', '2026-09-22T12:00:00.000Z'),
      record('r1', 't1', {}, '2026-09-22T12:00:00.000Z'),
    ];
    const { result } = collect([early, late]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.model).toBe('gpt-6-luna');
    expect(result.requestCount).toBe(1);
  });

  it('picks the same earliest-instant copy when the files are read in the opposite order', () => {
    const early = [
      turnContext('t1', 'gpt-6-luna', '2026-09-22T10:00:00.000Z'),
      record('r1', 't1', {}, '2026-09-22T10:00:00.000Z'),
    ];
    const late = [
      turnContext('t1', 'gpt-6-sol', '2026-09-22T12:00:00.000Z'),
      record('r1', 't1', {}, '2026-09-22T12:00:00.000Z'),
    ];
    const { result } = collect([late, early]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.model).toBe('gpt-6-luna');
    expect(result.requestCount).toBe(1);
  });

  it('keeps the already-stored copy when two resolved copies share the same instant', () => {
    const { result } = collect([
      [turnContext('t1', 'gpt-6-luna'), record('r1', 't1')],
      [turnContext('t1', 'gpt-6-sol'), record('r1', 't1')],
    ]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.model).toBe('gpt-6-luna');
  });

  it('does not let a malformed copy suppress a later valid one', () => {
    const malformed = JSON.stringify({
      timestamp: T,
      type: 'token_usage_record',
      payload: { response_id: 'r1', turn_id: 't1', usage: {} },
    });
    const { result, diagnostics } = collect([
      [turnContext('t1', 'm'), malformed],
      [turnContext('t1', 'm'), record('r1', 't1')],
    ]);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts.outputTokens).toBe(50);
    expect(diagnostics.malformedEvents).toBe(1);
  });

  it('only counts a fallback event that since keeps', () => {
    const { result, diagnostics } = collect(
      [[turnContext('t1', 'm'), tokenCount({}, '2026-09-01T12:00:00.000Z'), tokenCount({ output: 7 }, '2026-09-22T12:00:00.000Z')]],
      { since: new Date('2026-09-10T00:00:00.000Z') },
    );
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.counts.outputTokens).toBe(7);
    expect(diagnostics.fallbackEvents).toBe(1);
  });

  it('recognizes a rate-limit repeat even when the first copy of that total falls before since', () => {
    const { result, diagnostics } = collect(
      [[turnContext('t1', 'm'), tokenCount({}, '2026-09-01T12:00:00.000Z'), tokenCount({}, '2026-09-22T12:00:00.000Z')]],
      { since: new Date('2026-09-10T00:00:00.000Z') },
    );
    expect(result.usage).toEqual([]);
    expect(diagnostics.fallbackEvents).toBe(0);
  });

  it('collapses a repeated token_count with the same total (a rate-limit refresh) into one event', () => {
    const { result, diagnostics } = collect([[turnContext('t1', 'm'), tokenCount(), tokenCount()]]);
    expect(result.usage[0]!.counts.outputTokens).toBe(50);
    expect(diagnostics.fallbackEvents).toBe(1);
  });

  it('counts two token_count events with different totals separately', () => {
    const { result, diagnostics } = collect([[turnContext('t1', 'm'), tokenCount(), tokenCount({ output: 7 })]]);
    expect(result.usage[0]!.counts.outputTokens).toBe(57);
    expect(diagnostics.fallbackEvents).toBe(2);
  });

  it('disables the token_count fallback for a file with even one malformed token_usage_record line', () => {
    const malformed = JSON.stringify({
      timestamp: T,
      type: 'token_usage_record',
      payload: { response_id: 'r1', turn_id: 't1', usage: {} },
    });
    const { result, diagnostics } = collect([[turnContext('t1', 'm'), tokenCount(), malformed]]);
    expect(result.usage).toEqual([]);
    expect(diagnostics.fallbackEvents).toBe(0);
    expect(diagnostics.malformedEvents).toBe(1);
  });

  it('reads the fallback amount from last_token_usage, not the cumulative total_token_usage', () => {
    // A hand-built line whose total_token_usage (cumulative, output 999) is deliberately
    // different from last_token_usage (this event's own delta, output 7).
    const line = JSON.stringify({
      timestamp: T,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: usageFields({ output: 7 }),
          total_token_usage: usageFields({ output: 999 }),
        },
      },
    });
    const { result } = collect([[turnContext('t1', 'm'), line]]);
    expect(result.usage[0]!.counts.outputTokens).toBe(7);
  });

  it('throws if beginFile, addLine, or endFile is called after result() or diagnostics() has finalized it', () => {
    const aggregator = new CodexUsageAggregator({ timeZone: 'UTC' });
    aggregator.beginFile();
    aggregator.addLine(turnContext('t1', 'm'));
    aggregator.addLine(record('r1', 't1'));
    aggregator.endFile();
    aggregator.result();

    expect(() => aggregator.beginFile()).toThrow(/finaliz/i);
    expect(() => aggregator.addLine(record('r2', 't1'))).toThrow(/finaliz/i);
    expect(() => aggregator.endFile()).toThrow(/finaliz/i);
  });

  it('does not count a record that since drops from requestCount', () => {
    const { result } = collect(
      [
        [
          turnContext('t1', 'm'),
          record('old', 't1', {}, '2026-09-01T12:00:00.000Z'),
          record('late', 't1', {}, '2026-09-22T12:00:00.000Z'),
        ],
      ],
      { since: new Date('2026-09-10T00:00:00.000Z') },
    );
    expect(result.usage).toHaveLength(1);
    expect(result.requestCount).toBe(1);
  });
});

describe('CodexUsageAggregator pricing tiers', () => {
  it('puts a request over 272K input tokens in the long-context tier, per request', () => {
    const { result } = collect([
      [turnContext('t1', 'gpt-6-luna'), record('r1', 't1', { input: 272_000, cached: 0, cacheWrite: 0 }), record('r2', 't1', { input: 272_001, cached: 0, cacheWrite: 0 })],
    ]);
    expect(result.usage.map((u) => [u.pricingTier, u.counts.inputTokens])).toEqual([
      ['standard', 272_000],
      ['long-context', 272_001],
    ]);
  });

  it('marks requests after a fast or priority service tier as fast, until it is switched back', () => {
    const { result } = collect([
      [
        turnContext('t1', 'm'),
        serviceTier('fast'),
        record('r1', 't1'),
        serviceTier('default'),
        record('r2', 't1'),
        serviceTier('priority'),
        record('r3', 't1', { input: 400_000, cached: 0, cacheWrite: 0 }),
      ],
    ]);
    expect(result.usage.map((u) => u.pricingTier)).toEqual(['standard', 'fast', 'fast-long-context']);
  });

  it('starts every file at the standard tier', () => {
    const { result } = collect([[serviceTier('fast')], [turnContext('t1', 'm'), record('r1', 't1')]]);
    expect(result.usage[0]!.pricingTier).toBe('standard');
  });
});

describe('CodexUsageAggregator dates', () => {
  it('drops usage before since and buckets by local calendar day', () => {
    const { result } = collect(
      [
        [
          turnContext('t1', 'm'),
          record('old', 't1', {}, '2026-09-01T12:00:00.000Z'),
          record('late', 't1', {}, '2026-09-21T23:30:00.000Z'),
        ],
      ],
      { since: new Date('2026-09-10T00:00:00.000Z'), timeZone: 'Europe/Istanbul' },
    );
    expect(result.usage.map((u) => u.date)).toEqual(['2026-09-22']);
  });
});
