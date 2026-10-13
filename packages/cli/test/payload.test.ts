import { usagePayloadSchema, type DailyModelUsage, type PricingTier } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { buildUsagePayload } from '../src/payload.js';

const DEVICE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function usage(date: string, model: string, outputTokens = 1, pricingTier: PricingTier = 'standard'): DailyModelUsage {
  return {
    date,
    model,
    pricingTier,
    counts: {
      inputTokens: 0,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    },
  };
}

describe('buildUsagePayload', () => {
  it('groups models under their day, in date order', () => {
    const { payload } = buildUsagePayload(DEVICE, 'claude-code', [
      usage('2026-09-11', 'sonnet'),
      usage('2026-09-10', 'sonnet'),
      usage('2026-09-10', 'opus'),
    ]);
    expect(payload?.days.map((day) => [day.date, day.models.map((m) => m.model)])).toEqual([
      ['2026-09-10', ['sonnet', 'opus']],
      ['2026-09-11', ['sonnet']],
    ]);
  });

  it('produces a payload the server schema accepts', () => {
    const { payload } = buildUsagePayload(DEVICE, 'claude-code', [usage('2026-09-10', 'claude-sonnet-5', 42)]);
    expect(usagePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('returns a null payload and zero dropped when there is nothing to send', () => {
    expect(buildUsagePayload(DEVICE, 'claude-code', [])).toEqual({ payload: null, dropped: 0 });
  });

  it('trims entries that would get the whole upload rejected', () => {
    const many = Array.from({ length: 60 }, (_, index) => usage('2026-09-10', `model-${index}`, index));
    const { payload } = buildUsagePayload(DEVICE, 'claude-code', [...many, usage('2026-09-10', 'x'.repeat(121))]);
    const models = payload!.days[0]!.models;
    expect(models).toHaveLength(50);
    // The busiest models are the ones kept.
    expect(models[0]!.model).toBe('model-59');
    expect(models.some((m) => m.model.length > 120)).toBe(false);
    expect(usagePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('sends the tier only when it is not standard, as separate entries of one day', () => {
    const { payload } = buildUsagePayload(DEVICE, 'codex-cli', [
      usage('2026-09-22', 'gpt-6-luna', 5),
      usage('2026-09-22', 'gpt-6-luna', 9, 'long-context'),
    ]);
    const models = payload!.days[0]!.models;
    expect(models.map((m) => [m.model, m.pricingTier])).toEqual([
      ['gpt-6-luna', 'long-context'],
      ['gpt-6-luna', undefined],
    ]);
    expect('pricingTier' in models[1]!).toBe(false);
    expect(usagePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('omits an unknown cache split rather than sending zeros', () => {
    const entry = usage('2026-09-22', 'gpt-6-luna');
    entry.counts.cacheCreation5mTokens = null;
    entry.counts.cacheCreation1hTokens = null;
    const model = buildUsagePayload(DEVICE, 'codex-cli', [entry]).payload!.days[0]!.models[0]!;
    expect('cacheCreation5mTokens' in model).toBe(false);
    expect('cacheCreation1hTokens' in model).toBe(false);
  });

  it('drops an entry whose counts are not non-negative integers, and reports how many', () => {
    const good = usage('2026-09-22', 'good-model', 5);
    const negative = usage('2026-09-22', 'bad-model-1', -1);
    const fractional = usage('2026-09-22', 'bad-model-2');
    fractional.counts.cacheCreationTokens = 1.5;
    const { payload, dropped } = buildUsagePayload(DEVICE, 'claude-code', [good, negative, fractional]);
    expect(dropped).toBe(2);
    expect(payload!.days[0]!.models.map((m) => m.model)).toEqual(['good-model']);
    expect(usagePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('allows a null 5m/1h split through the boundary guard (unknown, not invalid)', () => {
    const entry = usage('2026-09-22', 'gpt-6-luna');
    entry.counts.cacheCreation5mTokens = null;
    entry.counts.cacheCreation1hTokens = null;
    const { payload, dropped } = buildUsagePayload(DEVICE, 'codex-cli', [entry]);
    expect(dropped).toBe(0);
    expect(payload!.days[0]!.models).toHaveLength(1);
  });
});
