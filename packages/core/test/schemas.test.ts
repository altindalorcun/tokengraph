import { describe, expect, it } from 'vitest';
import { usagePayloadSchema } from '../src/schemas.js';

const validPayload = {
  deviceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  source: 'claude-code',
  days: [
    {
      date: '2026-09-10',
      models: [
        {
          model: 'claude-sonnet-5',
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 40,
        },
      ],
    },
  ],
};

function parse(overrides: Record<string, unknown>) {
  return usagePayloadSchema.safeParse({ ...validPayload, ...overrides });
}

describe('usagePayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(usagePayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('requires a real device id', () => {
    expect(parse({ deviceId: 'device-1' }).success).toBe(false);
  });

  it('accepts only sources a CLI adapter produces', () => {
    expect(parse({ source: 'claude-code' }).success).toBe(true);
    expect(parse({ source: 'aider' }).success).toBe(false);
    expect(parse({ source: 'my-tool' }).success).toBe(false);
    expect(parse({ source: '../../etc/passwd' }).success).toBe(false);
  });

  it('rejects dates that are not real calendar days', () => {
    expect(parse({ days: [{ ...validPayload.days[0], date: '2026-02-30' }] }).success).toBe(false);
    expect(parse({ days: [{ ...validPayload.days[0], date: '10/09/2026' }] }).success).toBe(false);
  });

  it('rejects negative and fractional token counts', () => {
    const withCount = (inputTokens: number) => ({
      days: [{ date: '2026-09-10', models: [{ ...validPayload.days[0]!.models[0], inputTokens }] }],
    });
    expect(parse(withCount(-1)).success).toBe(false);
    expect(parse(withCount(1.5)).success).toBe(false);
    expect(parse(withCount(0)).success).toBe(true);
  });

  it('caps payload size so one request cannot flood the database', () => {
    const day = validPayload.days[0]!;
    expect(parse({ days: Array.from({ length: 401 }, () => day) }).success).toBe(false);
    expect(parse({ days: [] }).success).toBe(false);
  });

  it('caps how many models a single day may carry', () => {
    const model = validPayload.days[0]!.models[0]!;
    expect(
      parse({ days: [{ date: '2026-09-10', models: Array.from({ length: 51 }, () => model) }] }).success,
    ).toBe(false);
  });

  it('rejects an absurdly large token count', () => {
    expect(
      parse({
        days: [{ date: '2026-09-10', models: [{ ...validPayload.days[0]!.models[0], outputTokens: 1e13 }] }],
      }).success,
    ).toBe(false);
  });

  it('strips unknown fields rather than trusting them', () => {
    const result = usagePayloadSchema.safeParse({ ...validPayload, isAdmin: true });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('isAdmin');
  });

  it('accepts a payload without the cache-write split, for older CLI versions', () => {
    expect(usagePayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('accepts a payload that includes the cache-write split', () => {
    const withSplit = {
      days: [
        {
          date: '2026-09-10',
          models: [{ ...validPayload.days[0]!.models[0], cacheCreation5mTokens: 20, cacheCreation1hTokens: 10 }],
        },
      ],
    };
    expect(parse(withSplit).success).toBe(true);
  });
});

describe('pricingTier on an upload', () => {
  const base = {
    deviceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    source: 'codex-cli',
    days: [
      {
        date: '2026-09-22',
        models: [
          { model: 'gpt-6-luna', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        ],
      },
    ],
  };

  it('accepts a Codex upload without a tier (older CLIs) and with a known tier', () => {
    expect(usagePayloadSchema.safeParse(base).success).toBe(true);
    const tiered = structuredClone(base);
    (tiered.days[0]!.models[0] as Record<string, unknown>)['pricingTier'] = 'long-context';
    expect(usagePayloadSchema.safeParse(tiered).success).toBe(true);
  });

  it('rejects an unknown tier', () => {
    const bad = structuredClone(base);
    (bad.days[0]!.models[0] as Record<string, unknown>)['pricingTier'] = 'priority';
    expect(usagePayloadSchema.safeParse(bad).success).toBe(false);
  });
});
