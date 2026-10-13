import { describe, expect, it } from 'vitest';
import { addSdkMessages, type SdkMessagesFile } from '../src/adapters/cline/sdk.js';
import { emptyClineDiagnostics } from '../src/adapters/cline/normalize.js';
import { RequestBuckets } from '../src/adapters/request-buckets.js';

const UTC = { timeZone: 'UTC' };

function assistantMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    role: 'assistant',
    ts: Date.UTC(2026, 8, 27, 10, 0, 0),
    modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic', family: 'claude-sonnet-4' },
    metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.001 },
    content: [{ type: 'text', text: 'reply' }],
    ...overrides,
  };
}

function userMessage(id: string, text = 'hi') {
  return { id, role: 'user', content: [{ type: 'text', text }] };
}

function file(messages: unknown[], manifest: unknown | null = null): SdkMessagesFile {
  return { document: { version: 1, messages }, manifest };
}

describe('addSdkMessages', () => {
  it('the doc example message: fresh input, model and cache fields mapped through', () => {
    const buckets = new RequestBuckets();
    addSdkMessages(
      file([
        userMessage('msg_user_1'),
        assistantMessage('msg_mfx3k2_7', {
          metrics: { inputTokens: 52310, outputTokens: 412, cacheReadTokens: 48211, cacheWriteTokens: 3287, cost: 0.0412 },
        }),
      ]),
      buckets,
      emptyClineDiagnostics(),
      UTC,
    );
    expect(buckets.toUsage()).toEqual([
      {
        date: '2026-09-27',
        model: 'claude-sonnet-4-6',
        pricingTier: 'standard',
        counts: {
          inputTokens: 812,
          outputTokens: 412,
          cacheCreationTokens: 3287,
          cacheReadTokens: 48211,
          cacheCreation5mTokens: null,
          cacheCreation1hTokens: null,
        },
      },
    ]);
  });

  it('the same message id in two session files (a fork) is counted once', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(file([assistantMessage('shared-id')]), buckets, diagnostics, UTC);
    addSdkMessages(file([assistantMessage('shared-id')]), buckets, diagnostics, UTC);
    expect(buckets.size).toBe(1);
  });

  it('a message without ts is skipped and counted as malformed; provider "unknown" is skipped as a legacy copy', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(
      file([
        assistantMessage('no-ts', { ts: undefined }),
        assistantMessage('unknown-provider', { modelInfo: { id: 'x', provider: 'unknown' } }),
      ]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
    expect(diagnostics.skippedLegacyCopies).toBe(1);
  });

  it('a message with metrics but a non-object metrics value is skipped and counted as malformed', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(file([assistantMessage('bad-metrics', { metrics: 'not-an-object' })]), buckets, diagnostics, UTC);
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('a message with metrics: [] is skipped and counted as malformed, not read as all-zero counts', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(file([assistantMessage('array-metrics', { metrics: [] })]), buckets, diagnostics, UTC);
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('a message with a negative counter is skipped and counted as malformed, never coerced to 0', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(
      file([assistantMessage('negative-counter', { metrics: { inputTokens: -5, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } })]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('imported messages before importedAt are skipped, after it are counted; unparseable importedAt skips the whole file', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    const importedAt = '2026-09-27T10:00:00Z';
    addSdkMessages(
      file(
        [
          assistantMessage('before', { id: 'before', ts: Date.UTC(2026, 8, 27, 9, 0, 0) }),
          assistantMessage('after', { id: 'after', ts: Date.UTC(2026, 8, 27, 11, 0, 0) }),
        ],
        { metadata: { importedFrom: { tool: 'claude-code', importedAt } } },
      ),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(1);
    expect(diagnostics.skippedImported).toBe(1);

    const buckets2 = new RequestBuckets();
    const diagnostics2 = emptyClineDiagnostics();
    addSdkMessages(
      file([assistantMessage('a'), assistantMessage('b', { id: 'b' })], { metadata: { importedFrom: { tool: 'claude-code' } } }),
      buckets2,
      diagnostics2,
      UTC,
    );
    expect(buckets2.size).toBe(0);
    expect(diagnostics2.skippedImported).toBe(2);
  });

  it('legacy-migrated messages before the warning are skipped, after it are counted; a claimed migration with no warning skips the whole file', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(
      file(
        [
          assistantMessage('copy-1', { id: 'copy-1' }),
          assistantMessage('copy-2', { id: 'copy-2' }),
          userMessage('warning', 'Warning: this is a legacy conversation and usage before this point was already counted.'),
          assistantMessage('real', { id: 'real' }),
        ],
        { metadata: { legacyTask: true } },
      ),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(1);
    expect(diagnostics.skippedLegacyCopies).toBe(2);

    const buckets2 = new RequestBuckets();
    const diagnostics2 = emptyClineDiagnostics();
    addSdkMessages(
      file([assistantMessage('a'), assistantMessage('b', { id: 'b' })], { metadata: { migratedFromLegacyTask: true } }),
      buckets2,
      diagnostics2,
      UTC,
    );
    expect(buckets2.size).toBe(0);
    expect(diagnostics2.skippedLegacyCopies).toBe(2);
  });

  it('skips the claude-code provider (already counted from Claude Code)', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(
      file([assistantMessage('cc', { modelInfo: { id: 'claude-code-model', provider: 'claude-code' } })]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.skippedClaudeCode).toBe(1);
  });

  it('an out-of-range ts (finite but unparseable as a Date) is skipped and counted as malformed, never thrown', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    expect(() =>
      addSdkMessages(file([assistantMessage('huge-ts', { ts: 1e20 })]), buckets, diagnostics, UTC),
    ).not.toThrow();
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('reports the legacy synthetic total as a legacy copy even when its ts is also out of range', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(
      file([assistantMessage('legacy-bad-ts', { ts: 1e20, modelInfo: { id: 'x', provider: 'unknown' } })]),
      buckets,
      diagnostics,
      UTC,
    );
    expect(buckets.size).toBe(0);
    expect(diagnostics.skippedLegacyCopies).toBe(1);
    expect(diagnostics.malformedEntries).toBe(0);
  });

  it('a usage-bearing message with a missing or invalid id is counted as malformed, not silently skipped', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    addSdkMessages(file([assistantMessage('no-id', { id: undefined })]), buckets, diagnostics, UTC);
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(1);
  });

  it('ignores user messages and assistant messages without metrics', () => {
    const buckets = new RequestBuckets();
    const diagnostics = emptyClineDiagnostics();
    const noMetrics = assistantMessage('no-metrics') as Record<string, unknown>;
    delete noMetrics['metrics'];
    addSdkMessages(file([userMessage('u1'), noMetrics]), buckets, diagnostics, UTC);
    expect(buckets.size).toBe(0);
    expect(diagnostics.malformedEntries).toBe(0);
  });
});
