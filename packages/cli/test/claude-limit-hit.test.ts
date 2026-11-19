import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageAggregator } from '../src/adapters/claude-code/aggregator.js';
import { readLimitsFile, recordLimitHits } from '../src/limits/store.js';

/** The shape Claude Code writes when a request is refused for a plan limit (prompt and answer fields left out). */
function limitHit(timestamp: string, rateLimitType = 'five_hour', status = 'rejected', resetsAt: unknown = 1793911800): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { id: `m-${timestamp}`, model: '<synthetic>', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } },
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status, resetsAt, rateLimitType, overageStatus: 'rejected', isUsingOverage: false } },
    error: 'rate_limit',
    isApiErrorMessage: true,
  });
}

const usage = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-11-05T18:00:00.000Z',
  message: { id: 'real', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});

describe('Claude Code limit hits', () => {
  it('reads a refused request as a full window', () => {
    const aggregator = new UsageAggregator({ timeZone: 'UTC' });
    aggregator.addLine(limitHit('2026-11-05T19:12:56.289Z'));
    expect(aggregator.result('claude-code').limits).toEqual([
      {
        source: 'claude-code',
        limitId: null,
        plan: null,
        origin: 'limit-hit',
        readAt: '2026-11-05T19:12:56.289Z',
        credits: null,
        windows: [{ id: 'five_hour', minutes: 300, usedPercent: 100, resetsAt: new Date(1793911800 * 1000).toISOString() }],
      },
    ]);
  });

  it('keeps the newest hit per window', () => {
    const aggregator = new UsageAggregator({ timeZone: 'UTC' });
    aggregator.addLine(limitHit('2026-11-05T19:12:56.289Z'));
    aggregator.addLine(limitHit('2026-11-05T10:00:00.000Z'));
    aggregator.addLine(limitHit('2026-11-06T08:00:00.000Z', 'seven_day'));
    const limits = aggregator.result('claude-code').limits!;
    expect(limits.map((l) => [l.windows[0]!.id, l.readAt])).toEqual([
      ['five_hour', '2026-11-05T19:12:56.289Z'],
      ['seven_day', '2026-11-06T08:00:00.000Z'],
    ]);
  });

  it('ignores allowed requests, unreadable reset times and hits before the scan window', () => {
    const aggregator = new UsageAggregator({ timeZone: 'UTC', since: new Date('2026-11-05T00:00:00Z') });
    aggregator.addLine(limitHit('2026-11-05T19:00:00.000Z', 'five_hour', 'allowed'));
    aggregator.addLine(limitHit('2026-11-05T19:00:00.000Z', 'five_hour', 'rejected', '1793911800'));
    aggregator.addLine(limitHit('2026-11-04T19:00:00.000Z'));
    aggregator.addLine(limitHit('2026-11-05T20:00:00.000Z', 'overage'));
    expect(aggregator.result('claude-code').limits ?? []).toEqual([]);
  });

  it('does not change usage', () => {
    const plain = new UsageAggregator({ timeZone: 'UTC' });
    plain.addLine(usage);
    const withHit = new UsageAggregator({ timeZone: 'UTC' });
    withHit.addLine(usage);
    withHit.addLine(limitHit('2026-11-05T19:12:56.289Z'));
    const { limits: _ignored, ...rest } = withHit.result('claude-code');
    expect(rest).toEqual(plain.result('claude-code'));
  });

  it('recordLimitHits stores the Claude Code hits of a scan', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'limit-hits-')), 'limits.json');
    const aggregator = new UsageAggregator({ timeZone: 'UTC' });
    aggregator.addLine(limitHit('2026-11-05T19:12:56.289Z'));
    await recordLimitHits([aggregator.result('claude-code')], path);
    expect((await readLimitsFile(path)).claudeCode?.origin).toBe('limit-hit');
  });
});
