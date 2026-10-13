import { describe, expect, it } from 'vitest';
import { UsageAggregator } from '../src/adapters/claude-code/aggregator.js';

interface LineOverrides {
  id?: string;
  model?: string;
  timestamp?: string;
  isSidechain?: boolean;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  type?: string;
  /** usage.speed as Claude Code records it ("standard" or "fast"); omit for older records without it. */
  speed?: string;
  /** Present in real transcripts today; omit to simulate an older/truncated record. */
  cacheCreationSplit?: { ephemeral5m?: number; ephemeral1h?: number } | null;
}

function line(overrides: LineOverrides = {}): string {
  const cacheCreation = overrides.cacheCreation ?? 30;
  const usage: Record<string, unknown> = {
    input_tokens: overrides.input ?? 10,
    output_tokens: overrides.output ?? 20,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: overrides.cacheRead ?? 40,
  };
  if (overrides.speed !== undefined) usage['speed'] = overrides.speed;
  if (overrides.cacheCreationSplit !== null) {
    const split = overrides.cacheCreationSplit ?? { ephemeral5m: cacheCreation, ephemeral1h: 0 };
    usage['cache_creation'] = {
      ephemeral_5m_input_tokens: split.ephemeral5m ?? 0,
      ephemeral_1h_input_tokens: split.ephemeral1h ?? 0,
    };
  }
  return JSON.stringify({
    type: overrides.type ?? 'assistant',
    timestamp: overrides.timestamp ?? '2026-09-10T12:00:00.000Z',
    isSidechain: overrides.isSidechain ?? false,
    requestId: 'req_1',
    uuid: Math.random().toString(36),
    message: {
      id: overrides.id ?? 'msg_1',
      model: overrides.model ?? 'claude-sonnet-5',
      usage,
    },
  });
}

function aggregate(lines: string[], timeZone = 'UTC') {
  const aggregator = new UsageAggregator({ timeZone });
  for (const l of lines) aggregator.addLine(l);
  return aggregator.result('claude-code');
}

describe('UsageAggregator deduplication', () => {
  it('counts a message once no matter how many times it is written', () => {
    // Claude Code repeats the same message across streaming updates; observed
    // transcripts had up to 20 identical copies of one request.
    const result = aggregate(Array.from({ length: 20 }, () => line()));
    expect(result.requestCount).toBe(1);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.counts).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      cacheCreation5mTokens: 30,
      cacheCreation1hTokens: 0,
    });
  });

  it('puts an ordinary request in the standard tier', () => {
    expect(aggregate([line()]).usage[0]!.pricingTier).toBe('standard');
    expect(aggregate([line({ speed: 'standard' })]).usage[0]!.pricingTier).toBe('standard');
  });

  it('deduplicates across separate transcript files', () => {
    const aggregator = new UsageAggregator({ timeZone: 'UTC' });
    aggregator.addLine(line({ id: 'msg_a' }));
    aggregator.addLine(line({ id: 'msg_a' }));
    expect(aggregator.result('claude-code').requestCount).toBe(1);
  });

  it('keeps distinct messages separate', () => {
    const result = aggregate([line({ id: 'msg_a' }), line({ id: 'msg_b' })]);
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]!.counts.outputTokens).toBe(40);
  });

  it('does not use requestId, which is missing on some real records', () => {
    const withoutRequestId = JSON.parse(line({ id: 'msg_a' })) as Record<string, unknown>;
    delete withoutRequestId['requestId'];
    const aggregator = new UsageAggregator({ timeZone: 'UTC' });
    aggregator.addRecord(withoutRequestId);
    expect(aggregator.result('claude-code').requestCount).toBe(1);
  });

  // Real transcripts were found to carry growing, not identical, usage across copies of the
  // same message.id: Claude Code writes a streaming snapshot (sometimes output_tokens: 0/absent)
  // before the final, complete one. Keeping "whichever copy is seen first" — the old behavior —
  // locks in the incomplete snapshot whenever it is written (and therefore read) first, which is
  // the common case since lines are processed in file order. Observed real-world impact: output
  // tokens undercounted up to ~70x for some models.
  it('keeps the larger value when the first copy seen is an incomplete streaming snapshot', () => {
    const result = aggregate([line({ output: 8 }), line({ output: 454 })]);
    expect(result.usage[0]!.counts.outputTokens).toBe(454);
  });

  it('keeps the larger value regardless of which copy is seen first (order-independent)', () => {
    const result = aggregate([line({ output: 454 }), line({ output: 8 })]);
    expect(result.usage[0]!.counts.outputTokens).toBe(454);
  });

  it('takes the max per field independently, matching real data where input/cache stay stable while output grows', () => {
    const result = aggregate([
      line({ input: 2, output: 8, cacheRead: 76816, cacheCreation: 1073 }),
      line({ input: 2, output: 454, cacheRead: 76816, cacheCreation: 1073 }),
    ]);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 2, outputTokens: 454, cacheReadTokens: 76816, cacheCreationTokens: 1073 });
  });

  it('does not let a malformed copy of an id suppress a later valid one', () => {
    const malformed = JSON.parse(line({ id: 'msg_a', output: 999 })) as Record<string, unknown>;
    delete (malformed['message'] as Record<string, unknown>)['usage'];
    const aggregator = new UsageAggregator({ timeZone: 'UTC' });
    aggregator.addRecord(malformed);
    aggregator.addLine(line({ id: 'msg_a', output: 40 }));
    const result = aggregator.result('claude-code');
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts.outputTokens).toBe(40);
  });
});

describe('UsageAggregator filtering', () => {
  it('ignores non-assistant records', () => {
    const result = aggregate([line({ type: 'user' }), line({ type: 'summary', id: 'msg_b' })]);
    expect(result.usage).toHaveLength(0);
  });

  it('ignores synthetic messages, which are not real API calls', () => {
    const result = aggregate([line({ model: '<synthetic>' })]);
    expect(result.usage).toHaveLength(0);
    expect(result.requestCount).toBe(0);
  });

  it('counts subagent turns', () => {
    const result = aggregate([line({ isSidechain: true })]);
    expect(result.usage).toHaveLength(1);
  });

  it('drops records older than the since bound', () => {
    const aggregator = new UsageAggregator({
      timeZone: 'UTC',
      since: new Date('2026-09-01T00:00:00Z'),
    });
    aggregator.addLine(line({ id: 'old', timestamp: '2026-08-01T12:00:00.000Z' }));
    aggregator.addLine(line({ id: 'new', timestamp: '2026-09-05T12:00:00.000Z' }));
    expect(aggregator.result('claude-code').usage).toHaveLength(1);
    expect(aggregator.result('claude-code').usage[0]!.date).toBe('2026-09-05');
  });

  it('survives malformed lines', () => {
    const result = aggregate(['', 'not json', '{"type":"assistant"}', line()]);
    expect(result.usage).toHaveLength(1);
  });

  it('treats missing or negative token fields as zero', () => {
    const result = aggregate([line({ input: -5, cacheRead: Number.NaN })]);
    expect(result.usage[0]!.counts.inputTokens).toBe(0);
    expect(result.usage[0]!.counts.cacheReadTokens).toBe(0);
  });
});

describe('UsageAggregator cache-write split', () => {
  it('reads the 5m/1h breakdown when the transcript carries it', () => {
    const result = aggregate([
      line({ cacheCreation: 22025, cacheCreationSplit: { ephemeral5m: 0, ephemeral1h: 22025 } }),
    ]);
    expect(result.usage[0]!.counts.cacheCreation5mTokens).toBe(0);
    expect(result.usage[0]!.counts.cacheCreation1hTokens).toBe(22025);
  });

  it('attributes the whole cache write to the 5m tier when the breakdown is absent', () => {
    const result = aggregate([line({ cacheCreation: 500, cacheCreationSplit: null })]);
    expect(result.usage[0]!.counts.cacheCreation5mTokens).toBe(500);
    expect(result.usage[0]!.counts.cacheCreation1hTokens).toBe(0);
  });

  it('sums the split across deduplicated buckets like the other fields', () => {
    const result = aggregate([
      line({ id: 'a', cacheCreation: 100, cacheCreationSplit: { ephemeral5m: 100, ephemeral1h: 0 } }),
      line({ id: 'b', cacheCreation: 200, cacheCreationSplit: { ephemeral5m: 0, ephemeral1h: 200 } }),
    ]);
    expect(result.usage[0]!.counts.cacheCreation5mTokens).toBe(100);
    expect(result.usage[0]!.counts.cacheCreation1hTokens).toBe(200);
  });
});

describe('UsageAggregator grouping', () => {
  it('splits by day and model', () => {
    const result = aggregate([
      line({ id: 'a', timestamp: '2026-09-10T12:00:00Z', model: 'claude-sonnet-5' }),
      line({ id: 'b', timestamp: '2026-09-10T13:00:00Z', model: 'claude-opus-5' }),
      line({ id: 'c', timestamp: '2026-09-11T13:00:00Z', model: 'claude-sonnet-5' }),
    ]);
    expect(result.usage.map((u) => `${u.date} ${u.model}`)).toEqual([
      '2026-09-10 claude-opus-5',
      '2026-09-10 claude-sonnet-5',
      '2026-09-11 claude-sonnet-5',
    ]);
  });

  it('assigns days using the configured time zone', () => {
    const late = line({ timestamp: '2026-09-10T23:00:00Z' });
    expect(aggregate([late], 'UTC').usage[0]!.date).toBe('2026-09-10');
    expect(aggregate([late], 'Europe/Istanbul').usage[0]!.date).toBe('2026-09-11');
  });
});

describe('UsageAggregator pricing tiers', () => {
  it('tiers each Haiku 5.5 request by its own prompt length, cache reads and writes included', () => {
    const result = aggregate([
      line({ id: 'short', model: 'claude-haiku-5-5', input: 10, cacheCreation: 0, cacheRead: 100_000 - 10 }),
      line({ id: 'long', model: 'claude-haiku-5-5', input: 10, cacheCreation: 1, cacheRead: 100_000 - 10 }),
      line({ id: 'long-2', model: 'claude-haiku-5-5', input: 200_000, cacheCreation: 0, cacheRead: 0 }),
    ]);
    expect(result.usage.map((u) => [u.model, u.pricingTier, u.counts.inputTokens])).toEqual([
      ['claude-haiku-5-5', 'standard', 10],
      ['claude-haiku-5-5', 'long-context', 200_010],
    ]);
  });

  it('decides the tier from the merged counts, not from an early streaming copy', () => {
    const result = aggregate([
      line({ id: 'm', model: 'claude-haiku-5-5', input: 10, cacheRead: 0, cacheCreation: 0 }),
      line({ id: 'm', model: 'claude-haiku-5-5', input: 10, cacheRead: 150_000, cacheCreation: 0 }),
    ]);
    expect(result.usage.map((u) => u.pricingTier)).toEqual(['long-context']);
  });

  it('records fast mode from usage.speed', () => {
    const result = aggregate([
      line({ id: 'a', model: 'claude-opus-5-5', speed: 'fast' }),
      line({ id: 'b', model: 'claude-opus-5-5', speed: 'standard' }),
    ]);
    expect(result.usage.map((u) => u.pricingTier)).toEqual(['standard', 'fast']);
  });
});
