import { describe, expect, it } from 'vitest';
import type { CursorEvent } from '../src/adapters/cursor/events.js';
import {
  CursorUsageAggregator,
  cursorModelIdentity,
  MAX_MODEL_NAME_LENGTH,
  normalizeCursorModel,
} from '../src/adapters/cursor/aggregator.js';

function event(overrides: Partial<CursorEvent> = {}): CursorEvent {
  return {
    v: 1,
    receivedAt: '2026-09-24T12:00:00.000Z',
    generationId: 'gen-1',
    model: 'composer-2.5',
    modelId: 'composer-2.5',
    fast: false,
    status: 'completed',
    cursorVersion: '3.14.7',
    inputTokens: 1000,
    outputTokens: 50,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    ...overrides,
  };
}

function collect(events: CursorEvent[], options = {}) {
  const aggregator = new CursorUsageAggregator({ timeZone: 'UTC', ...options });
  for (const e of events) aggregator.add(e);
  return { result: aggregator.result(), diagnostics: aggregator.diagnostics() };
}

describe('CursorUsageAggregator normalisation', () => {
  it('splits cache reads and writes out of input, with an unknown cache split', () => {
    const { result } = collect([event()]);
    expect(result.source).toBe('cursor');
    expect(result.requestCount).toBe(1);
    expect(result.usage).toEqual([
      {
        date: '2026-09-24',
        model: 'composer-2.5',
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

  it('sums distinct turns of a day and keeps the split null', () => {
    const { result } = collect([event(), event({ generationId: 'gen-2' })]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 600, outputTokens: 100, cacheCreation5mTokens: null });
    expect(result.requestCount).toBe(2);
  });

  it('treats missing cache counts as zero', () => {
    const { result } = collect([event({ cacheReadTokens: null, cacheWriteTokens: null })]);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it('clamps a negative fresh input to zero and reports it', () => {
    const { result, diagnostics } = collect([event({ inputTokens: 100, cacheReadTokens: 90, cacheWriteTokens: 20 })]);
    expect(result.usage[0]!.counts.inputTokens).toBe(0);
    expect(diagnostics.clampedEvents).toBe(1);
  });
});

describe('CursorUsageAggregator dedup and gaps', () => {
  it('dedups by generation_id, keeping the per-field max', () => {
    const { result } = collect([event({ outputTokens: 10 }), event({ outputTokens: 50 }), event({ outputTokens: 30 })]);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts.outputTokens).toBe(50);
  });

  it('skips turns without token counts rather than counting them as zero', () => {
    const { result, diagnostics } = collect([
      event({ inputTokens: null }),
      event({ generationId: 'gen-2', outputTokens: null }),
      event({ generationId: 'gen-3' }),
    ]);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts.outputTokens).toBe(50);
    expect(diagnostics.missingCounts).toBe(2);
  });

  it('counts aborted and errored turns that still report tokens', () => {
    const { result } = collect([event({ status: 'aborted' }), event({ generationId: 'gen-2', status: 'error' })]);
    expect(result.requestCount).toBe(2);
  });

  it('drops turns before since and buckets by the local calendar day', () => {
    const { result } = collect(
      [
        event({ generationId: 'old', receivedAt: '2026-09-01T12:00:00.000Z' }),
        event({ generationId: 'late', receivedAt: '2026-09-21T23:30:00.000Z' }),
      ],
      { since: new Date('2026-09-10T00:00:00.000Z'), timeZone: 'Europe/Istanbul' },
    );
    expect(result.usage.map((u) => u.date)).toEqual(['2026-09-22']);
    expect(result.requestCount).toBe(1);
  });
});

describe('normalizeCursorModel', () => {
  it.each([
    ['claude-4.5-opus-high-thinking', 'claude-opus-4-5'],
    ['claude-4.6-opus-high-thinking', 'claude-opus-4-6'],
    ['claude-4.5-sonnet-thinking', 'claude-sonnet-4-5'],
    ['claude-4.6-sonnet-medium-thinking', 'claude-sonnet-4-6'],
    ['claude-5-opus-max-thinking', 'claude-opus-5'],
    ['Claude-4.5-Opus-High-Thinking', 'claude-opus-4-5'],
    ['claude-opus-4.6', 'claude-opus-4-6'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['claude-opus-4-8', 'claude-opus-4-8'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
    ['claude-3.7-sonnet-thinking', 'claude-3-7-sonnet'],
    ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022'],
    ['claude-4-sonnet', 'claude-sonnet-4'],
    ['claude-4-opus', 'claude-opus-4'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normalizeCursorModel(raw)).toBe(expected);
  });

  it.each(['gpt-5.3-codex', 'gemini-3-pro', 'grok-code', 'composer-2.5', 'default', 'unknown', 'claude-thinking'])(
    'leaves %s alone rather than guessing',
    (raw) => {
      expect(normalizeCursorModel(raw)).toBe(raw);
    },
  );

  it('does not merge parts glued together by anything other than a hyphen', () => {
    expect(normalizeCursorModel('claude-opus-4-5@20251101')).toBe('claude-opus-4-5@20251101');
  });
});

describe('cursorModelIdentity', () => {
  it('prefers model_id, then model, then unknown', () => {
    expect(cursorModelIdentity(event({ modelId: 'composer-2.5', model: 'other' }))).toEqual({
      model: 'composer-2.5',
      pricingTier: 'standard',
    });
    expect(cursorModelIdentity(event({ modelId: null, model: 'claude-sonnet-4-6' }))).toEqual({
      model: 'claude-sonnet-4-6',
      pricingTier: 'standard',
    });
    expect(cursorModelIdentity(event({ modelId: null, model: null }))).toEqual({ model: 'unknown', pricingTier: 'standard' });
  });

  it('stores Cursor Claude usage under the canonical id so it merges with other tools', () => {
    expect(cursorModelIdentity(event({ modelId: 'claude-4.5-opus-high-thinking' }))).toEqual({
      model: 'claude-opus-4-5',
      pricingTier: 'standard',
    });
  });

  it('keeps Composer Fast as its own model, priced at its own published rates', () => {
    expect(cursorModelIdentity(event({ fast: true }))).toEqual({ model: 'composer-2.5-fast', pricingTier: 'standard' });
    expect(cursorModelIdentity(event({ fast: true, modelId: 'composer-2.5-fast' }))).toEqual({
      model: 'composer-2.5-fast',
      pricingTier: 'standard',
    });
  });

  it('recognizes Composer Fast regardless of casing', () => {
    expect(cursorModelIdentity(event({ modelId: 'Composer-2.5', fast: true }))).toEqual({
      model: 'composer-2.5-fast',
      pricingTier: 'standard',
    });
  });

  it('records fast mode on other models as the fast tier, without renaming the model', () => {
    expect(cursorModelIdentity(event({ modelId: 'claude-4.6-opus-high-thinking', fast: true }))).toEqual({
      model: 'claude-opus-4-6',
      pricingTier: 'fast',
    });
    expect(cursorModelIdentity(event({ modelId: 'gpt-5.3-codex', fast: true }))).toEqual({
      model: 'gpt-5.3-codex',
      pricingTier: 'fast',
    });
  });

  it('picks up a fast word embedded in the raw slug even when the fast flag is false', () => {
    expect(cursorModelIdentity(event({ modelId: 'claude-4.5-opus-high-thinking-fast', fast: false }))).toEqual({
      model: 'claude-opus-4-5',
      pricingTier: 'fast',
    });
  });

  it('groups Fast and Standard turns of one day into separate model rows', () => {
    const { result } = collect([event(), event({ generationId: 'gen-2', fast: true })]);
    expect(result.usage.map((u) => u.model)).toEqual(['composer-2.5', 'composer-2.5-fast']);
  });

  it('truncates a model id longer than the server limit so the name stays uploadable', () => {
    const longId = 'x'.repeat(200);
    const { model } = cursorModelIdentity(event({ modelId: longId, model: null }));
    expect(model.length).toBeLessThanOrEqual(MAX_MODEL_NAME_LENGTH);
    expect(model).toBe(longId.slice(0, MAX_MODEL_NAME_LENGTH));
  });

  it('truncates a long fast composer id so the -fast suffix still fits within the limit', () => {
    const longId = 'composer-' + 'y'.repeat(191);
    const { model } = cursorModelIdentity(event({ modelId: longId, model: null, fast: true }));
    expect(model.length).toBeLessThanOrEqual(MAX_MODEL_NAME_LENGTH);
    expect(model.endsWith('-fast')).toBe(true);
    expect(model).toBe(`${longId.slice(0, MAX_MODEL_NAME_LENGTH - '-fast'.length)}-fast`);
  });

  it('sorts usage by date, model, then pricing tier (standard before fast)', () => {
    const { result } = collect([
      event({ generationId: 'gen-1', modelId: 'claude-4.6-opus-high-thinking', fast: false }),
      event({ generationId: 'gen-2', modelId: 'claude-4.6-opus-high-thinking', fast: true }),
    ]);
    expect(result.usage.map((u) => ({ model: u.model, pricingTier: u.pricingTier }))).toEqual([
      { model: 'claude-opus-4-6', pricingTier: 'standard' },
      { model: 'claude-opus-4-6', pricingTier: 'fast' },
    ]);
  });
});
