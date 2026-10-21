import { describe, expect, it } from 'vitest';
import { OpenCodeAggregator, type OpenCodeMessage, type OpenCodeSession, type OpenCodeV2Message } from '../src/adapters/opencode/aggregator.js';

const CREATED = Date.parse('2026-09-27T10:00:00Z');
const SESSION_CREATED = Date.parse('2026-09-01T00:00:00Z');

const NEW_SESSION: OpenCodeSession = { id: 's1', version: '1.18.32', createdMs: SESSION_CREATED };

function stepTokens(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, reasoning: 0, total: null, cache: { read: cacheRead, write: cacheWrite } };
}

function message(overrides: Partial<OpenCodeMessage> = {}): OpenCodeMessage {
  return {
    id: 'msg_1',
    sessionId: 's1',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    createdMs: CREATED,
    completedMs: CREATED + 1000,
    agent: 'build',
    cost: 0.01,
    tokens: stepTokens(0, 0),
    steps: [],
    ...overrides,
  };
}

describe('OpenCodeAggregator v1 request units', () => {
  it('counts each step-finish part as its own request and ignores the message\'s own (overwritten) tokens', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(
      message({
        tokens: stepTokens(30, 20), // equal to the last step; must not be added again
        steps: [stepTokens(10, 5), stepTokens(30, 20)],
      }),
    );
    const result = aggregator.result();
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 40, outputTokens: 25 });
  });

  it('counts the message\'s own tokens once when it has no steps', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ tokens: stepTokens(10, 5), steps: [] }));
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('keeps the copy with more steps when the same id arrives twice (JSON then SQLite)', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'msg_1', tokens: stepTokens(10, 5), steps: [stepTokens(10, 5)] }));
    aggregator.addV1Message(
      message({ id: 'msg_1', tokens: stepTokens(30, 20), steps: [stepTokens(10, 5), stepTokens(30, 20)] }),
    );
    const result = aggregator.result();
    expect(result.requestCount).toBe(2);
  });

  it('counts a v1 fork clone once, and does not report the key as skipped even though the clone alone would hit the aisdk6 window', () => {
    // A real fork clone: the original message lives in its own session, created before the
    // message (so the period-D shortcut applies to it directly). The clone carries the exact
    // same data (same fingerprint) under a new id, but sits in a *fork* session created AFTER
    // the message's own createdMs — so for the clone, messageCreatedMs < sessionCreatedMs, the
    // shortcut does not apply, and it falls through to the full candidate rule. The record is
    // D-shaped (cache > 0, reasoning = 0) and created after the AI SDK 6 cutover, so the clone's
    // own (weaker) context alone would resolve to `skip: 'aisdk6-window'` — but since the
    // original resolved successfully under the same request key, the key must be counted once
    // with no skip diagnostic at all.
    const aggregator = new OpenCodeAggregator();
    const originalSession: OpenCodeSession = { id: 's-orig', version: '1.18.32', createdMs: Date.parse('2026-03-01T00:00:00Z') };
    const forkSession: OpenCodeSession = { id: 's-fork', version: '1.18.32', createdMs: Date.parse('2026-04-01T00:00:00Z') };
    aggregator.addSession(originalSession);
    aggregator.addSession(forkSession);
    const shared = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      createdMs: Date.parse('2026-03-28T00:00:00Z'), // after the 2026-03-27 cutover, before both sessions but s-orig's
      completedMs: Date.parse('2026-03-28T00:00:05Z'),
      agent: 'build',
      cost: 0.02,
      tokens: { input: 100, output: 60, reasoning: 0, total: 560, cache: { read: 400, write: 0 } },
      steps: [] as unknown[],
    };
    aggregator.addV1Message({ id: 'msg_orig', sessionId: 's-orig', ...shared });
    aggregator.addV1Message({ id: 'msg_clone', sessionId: 's-fork', ...shared });
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 100, outputTokens: 60, cacheReadTokens: 400, cacheCreationTokens: 0 });
    expect(aggregator.diagnostics().skippedOld).toBe(0);
  });

  it('gives the same result when addSession is called after the messages, for a record only the period-D shortcut can count', () => {
    // cache > 0 and total: null fails resolveV1Tokens's no-context "rule 2" (which only accepts a
    // missing total when cache and reasoning are both absent), so this record is only counted at
    // all via the period-D shortcut — which needs the session's version and createdMs to be found.
    // That makes the test genuinely depend on addSession having been registered, in either order.
    const build = (sessionFirst: boolean) => {
      const aggregator = new OpenCodeAggregator();
      const addMessage = () => aggregator.addV1Message(message({ tokens: stepTokens(10, 5, 3, 0), steps: [] }));
      const addSess = () => aggregator.addSession(NEW_SESSION);
      if (sessionFirst) {
        addSess();
        addMessage();
      } else {
        addMessage();
        addSess();
      }
      return aggregator.result();
    };
    const result = build(false);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
    expect(result).toEqual(build(true));
  });
});

describe('OpenCodeAggregator v2 rows', () => {
  function v2Message(overrides: Partial<OpenCodeV2Message> = {}): OpenCodeV2Message {
    return {
      id: 'v2_1',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      createdMs: CREATED,
      completedMs: CREATED + 1000,
      agent: 'build',
      cost: 0.01,
      tokens: stepTokens(10, 5, 3, 2),
      ...overrides,
    };
  }

  it('skips a v2 row whose id matches a v1 message id (v1 wins)', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'shared_id', tokens: stepTokens(999, 999), steps: [] }));
    aggregator.addV2Message(v2Message({ id: 'shared_id', tokens: stepTokens(1, 1) }));
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 999, outputTokens: 999 });
  });

  it('counts a v2-only row via resolveV2Tokens (reasoning folded into output)', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addV2Message(v2Message({ id: 'v2_only', tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 2 } } }));
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cacheCreationTokens: 2,
      cacheReadTokens: 7,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    });
  });

  it('counts two v2 fork copies (identical data, different ids) once', () => {
    const aggregator = new OpenCodeAggregator();
    const shared = { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', createdMs: CREATED, completedMs: CREATED + 500, agent: 'build', cost: 0.02, tokens: stepTokens(10, 5, 3, 2) };
    aggregator.addV2Message({ id: 'fork1_0', ...shared });
    aggregator.addV2Message({ id: 'fork2_0', ...shared });
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
  });

  it('does not double-count a v2 fork copy of a v1-migrated row (fork id sorts after the migrated id)', () => {
    // v2's own migration copies a v1 message under the same id (here 'msg_a'); a fork made from
    // that forked session then copies the migrated row again, verbatim, under a fresh
    // `<forkEventId>_<seq>` id ('zzz_fork_0', sorting after 'msg_a'). Neither v2 row should be
    // counted: v1's own step-finish record is authoritative, and the fork copy carries no new
    // request, just a duplicate of the migrated one.
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'msg_a', tokens: stepTokens(10, 5), steps: [] }));
    const migrated = v2Message({ id: 'msg_a', tokens: stepTokens(10, 5) });
    aggregator.addV2Message(migrated);
    aggregator.addV2Message({ ...migrated, id: 'zzz_fork_0' });
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(aggregator.diagnostics()).toEqual({ skippedOld: 0, invalidRecords: 0, skippedClaudeCode: 0, unreadableSources: 0 });
  });

  it('does not double-count a v2 fork copy of a v1-migrated row, order-independent (fork id sorts before the migrated id)', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'msg_a', tokens: stepTokens(10, 5), steps: [] }));
    const migrated = v2Message({ id: 'msg_a', tokens: stepTokens(10, 5) });
    aggregator.addV2Message(migrated);
    // 'aaa_fork_0' sorts before 'msg_a', so the fork copy is processed before the migrated row
    // it was copied from — the dedup must not depend on which one is seen first.
    aggregator.addV2Message({ ...migrated, id: 'aaa_fork_0' });
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(aggregator.diagnostics()).toEqual({ skippedOld: 0, invalidRecords: 0, skippedClaudeCode: 0, unreadableSources: 0 });
  });

  it('does not double-count a v2 fork copy once the migrated v2 row itself is gone (only a v1 identity match, no shared id)', () => {
    // The migration copy that would normally share v1's id (and so register the id/fingerprint
    // sentinel) has been deleted; only a fork copy under a fresh id remains. It must still be
    // recognised as v1's own request via the identity fields (createdMs, completedMs, providerId,
    // modelId, agent) alone — tokens/cost are deliberately excluded, since migration rewrites them.
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    const v1 = message({ id: 'msg_x', tokens: stepTokens(10, 5), steps: [] });
    aggregator.addV1Message(v1);
    // No v2 row with id 'msg_x' at all — just the fork copy, under a new id, with the same
    // identity fields as v1 but arbitrary (bogus) token data of its own.
    aggregator.addV2Message({
      id: 'zzz_fork_0',
      providerId: v1.providerId,
      modelId: v1.modelId,
      createdMs: v1.createdMs,
      completedMs: v1.completedMs,
      agent: v1.agent,
      cost: v1.cost,
      tokens: stepTokens(999, 999),
    });
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.counts).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('OpenCodeAggregator claude-code provider guard', () => {
  it('skips a v1 message and a v2 row from the claude-code provider, case-insensitively, and tallies skippedClaudeCode', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'v1_cc', providerId: 'Claude-Code', tokens: stepTokens(10, 5), steps: [] }));
    aggregator.addV2Message({
      id: 'v2_cc',
      providerId: 'claude-code',
      modelId: null,
      createdMs: CREATED,
      completedMs: CREATED + 500,
      agent: 'build',
      cost: 0.01,
      tokens: stepTokens(10, 5),
    });
    const result = aggregator.result();
    expect(result.requestCount).toBe(0);
    expect(aggregator.diagnostics().skippedClaudeCode).toBe(2);
  });
});

describe('OpenCodeAggregator invalid timestamps', () => {
  it('drops a v1 message and a v2 row whose createdMs is finite but out of Date range, without throwing', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'v1_bad_ts', createdMs: 1e20, tokens: stepTokens(10, 5), steps: [] }));
    aggregator.addV2Message({
      id: 'v2_bad_ts',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      createdMs: 1e20,
      completedMs: null,
      agent: 'build',
      cost: 0.01,
      tokens: stepTokens(10, 5),
    });
    let result;
    expect(() => {
      result = aggregator.result();
    }).not.toThrow();
    expect(result!.requestCount).toBe(0);
    expect(aggregator.diagnostics().invalidRecords).toBe(2);
  });
});

describe('OpenCodeAggregator diagnostics', () => {
  it('does not count messages from an old session with cache and no total, and tallies skippedOld', () => {
    const aggregator = new OpenCodeAggregator();
    const oldSession: OpenCodeSession = { id: 's-old', version: '1.2.0', createdMs: Date.parse('2026-02-20T00:00:00Z') };
    aggregator.addSession(oldSession);
    aggregator.addV1Message(
      message({
        id: 'msg_old',
        sessionId: 's-old',
        createdMs: Date.parse('2026-02-21T10:00:00Z'),
        tokens: { input: 10, output: 5, reasoning: 0, total: null, cache: { read: 100, write: 0 } },
        steps: [],
      }),
    );
    const result = aggregator.result();
    expect(result.requestCount).toBe(0);
    expect(aggregator.diagnostics().skippedOld).toBe(1);
  });

  it('tallies invalidRecords for tokens missing a required counter', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'msg_bad', tokens: { output: 5 }, steps: [] }));
    const result = aggregator.result();
    expect(result.requestCount).toBe(0);
    expect(aggregator.diagnostics().invalidRecords).toBe(1);
  });

  it('reports unreadable sources noted from outside the aggregator', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.noteUnreadableSource();
    aggregator.noteUnreadableSource();
    expect(aggregator.diagnostics().unreadableSources).toBe(2);
  });
});

describe('OpenCodeAggregator model naming, since and time zone', () => {
  it('canonicalizes an OpenRouter Claude model id and keeps an unrecognised custom one as-is', () => {
    const aggregator = new OpenCodeAggregator();
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(
      message({ id: 'msg_or', providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', tokens: stepTokens(10, 5), steps: [] }),
    );
    aggregator.addV1Message(
      message({ id: 'msg_ollama', providerId: 'ollama', modelId: 'qwen3-coder:30b', tokens: stepTokens(10, 5), steps: [] }),
    );
    const result = aggregator.result();
    const models = result.usage.map((u) => u.model).sort();
    expect(models).toEqual(['claude-sonnet-4-5', 'qwen3-coder:30b']);
  });

  it('applies since and buckets dates by the given time zone; preserves the null cache split', () => {
    const aggregator = new OpenCodeAggregator({ since: new Date('2026-09-10T00:00:00.000Z'), timeZone: 'Europe/Istanbul' });
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(
      message({ id: 'msg_old2', createdMs: Date.parse('2026-09-01T00:00:00Z'), tokens: stepTokens(10, 5), steps: [] }),
    );
    aggregator.addV1Message(
      message({ id: 'msg_new', createdMs: Date.parse('2026-09-26T22:30:00.000Z'), tokens: stepTokens(10, 5), steps: [] }),
    );
    const result = aggregator.result();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]!.date).toBe('2026-09-27');
    expect(result.usage[0]!.counts.cacheCreation5mTokens).toBeNull();
    expect(result.usage[0]!.counts.cacheCreation1hTokens).toBeNull();
  });

  it('reports source opencode', () => {
    const aggregator = new OpenCodeAggregator();
    expect(aggregator.result().source).toBe('opencode');
  });
});

describe('OpenCodeAggregator hours', () => {
  it('buckets each request by the hour of its message', () => {
    const aggregator = new OpenCodeAggregator({ timeZone: 'UTC' });
    aggregator.addSession(NEW_SESSION);
    aggregator.addV1Message(message({ id: 'm1', createdMs: Date.parse('2026-09-27T10:00:00Z'), tokens: stepTokens(10, 5), steps: [] }));
    aggregator.addV1Message(message({ id: 'm2', createdMs: Date.parse('2026-09-27T15:30:00Z'), tokens: stepTokens(20, 5), steps: [] }));
    expect(aggregator.result().hours).toEqual([
      { date: '2026-09-27', hour: 10, weighted: 15 },
      { date: '2026-09-27', hour: 15, weighted: 25 },
    ]);
  });
});
