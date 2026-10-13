import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseStoredTokens,
  resolveV1Tokens,
  resolveV2Tokens,
  type StoredTokens,
  type VersionContext,
} from '../src/adapters/opencode/semantics.js';

/** Builds a StoredTokens with the note's I/O/R/CR/CW/T notation, T defaulting to null. */
function tokens(I: number, O: number, R: number, CR: number, CW: number, T: number | null = null): StoredTokens {
  return { input: I, output: O, reasoning: R, cacheRead: CR, cacheWrite: CW, total: T };
}

const NEW: VersionContext = {
  sessionVersion: '1.18.32',
  sessionCreatedMs: Date.parse('2026-09-01T00:00:00Z'),
  messageCreatedMs: Date.parse('2026-09-27T10:00:00Z'),
};

const OLD: VersionContext = {
  sessionVersion: '1.2.0',
  sessionCreatedMs: Date.parse('2026-02-20T00:00:00Z'),
  messageCreatedMs: Date.parse('2026-02-21T10:00:00Z'),
};

describe('resolveV1Tokens', () => {
  it('applies the period-D shortcut for a current-version session (the note\'s example)', () => {
    const result = resolveV1Tokens(tokens(12, 812, 0, 48210, 1536, 50570), NEW);
    expect(result).toEqual({
      counts: {
        inputTokens: 12,
        outputTokens: 812,
        cacheCreationTokens: 1536,
        cacheReadTokens: 48210,
        cacheCreation5mTokens: null,
        cacheCreation1hTokens: null,
      },
    });
  });

  it('period-D shortcut folds reasoning into output', () => {
    const result = resolveV1Tokens(tokens(100, 50, 30, 0, 0, 180), NEW);
    expect(result).toEqual({ counts: expect.objectContaining({ inputTokens: 100, outputTokens: 80 }) });
  });

  it('a fork clone (message older than its new session) goes through the full rule, not the shortcut', () => {
    const context: VersionContext = {
      sessionVersion: '1.18.32',
      sessionCreatedMs: Date.parse('2026-09-01T00:00:00Z'),
      messageCreatedMs: Date.parse('2026-02-21T10:00:00Z'),
    };
    const result = resolveV1Tokens(tokens(12, 812, 0, 48210, 1536, 50570), context);
    expect(result).toEqual({
      counts: expect.objectContaining({ inputTokens: 12, outputTokens: 812, cacheReadTokens: 48210, cacheCreationTokens: 1536 }),
    });
  });

  it('no total, no cache/reasoning (OLD) is counted as-is', () => {
    const result = resolveV1Tokens(tokens(10, 5, 0, 0, 0, null), OLD);
    expect(result).toEqual({ counts: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }) });
  });

  it('no total with cache present cannot be resolved', () => {
    const result = resolveV1Tokens(tokens(10, 5, 0, 100, 0, null), OLD);
    expect(result).toEqual({ skip: 'no-total' });
  });

  it('OLD OpenAI-style record: only ny matches', () => {
    const result = resolveV1Tokens(tokens(100, 60, 20, 400, 0, 560), OLD);
    expect(result).toEqual({ counts: expect.objectContaining({ inputTokens: 100, outputTokens: 60 }) });
  });

  it('OLD Google-style record: only nn matches', () => {
    const result = resolveV1Tokens(tokens(100, 40, 20, 400, 0, 560), OLD);
    expect(result).toEqual({ counts: expect.objectContaining({ inputTokens: 100, outputTokens: 60 }) });
  });

  it('yn vs ny conflict is ambiguous', () => {
    const result = resolveV1Tokens(tokens(500, 460, 400, 400, 0, 1360), OLD);
    expect(result).toEqual({ skip: 'ambiguous' });
  });

  it('only y* candidates match with cache present: ambiguous', () => {
    const result = resolveV1Tokens(tokens(500, 60, 0, 400, 0, 560), OLD);
    expect(result).toEqual({ skip: 'ambiguous' });
  });

  it('no candidate matches (Gemini tool-use prompt): ambiguous', () => {
    const result = resolveV1Tokens(tokens(100, 40, 20, 0, 0, 170), OLD);
    expect(result).toEqual({ skip: 'ambiguous' });
  });

  it('AI SDK 6 double-count window (1.3.4, R=0, cache present): skipped', () => {
    const context: VersionContext = {
      sessionVersion: '1.3.4',
      sessionCreatedMs: Date.parse('2026-03-29T00:00:00Z'),
      messageCreatedMs: Date.parse('2026-03-29T12:00:00Z'),
    };
    const result = resolveV1Tokens(tokens(48000, 800, 0, 47000, 500, 96300), context);
    expect(result).toEqual({ skip: 'aisdk6-window' });
  });

  it('same record with session 1.3.6, message after session creation: counted', () => {
    const context: VersionContext = {
      sessionVersion: '1.3.6',
      sessionCreatedMs: Date.parse('2026-03-30T00:00:00Z'),
      messageCreatedMs: Date.parse('2026-03-30T12:00:00Z'),
    };
    const result = resolveV1Tokens(tokens(48000, 800, 0, 47000, 500, 96300), context);
    expect(result).toEqual({ counts: expect.objectContaining({ inputTokens: 48000, outputTokens: 800 }) });
  });

  it('unparseable session version inside the window: skipped', () => {
    const context: VersionContext = {
      sessionVersion: '0.0.0-dev-202603291200',
      sessionCreatedMs: Date.parse('2026-03-29T00:00:00Z'),
      messageCreatedMs: Date.parse('2026-03-29T12:00:00Z'),
    };
    const result = resolveV1Tokens(tokens(48000, 800, 0, 47000, 500, 96300), context);
    expect(result).toEqual({ skip: 'aisdk6-window' });
  });

  it('R > 0 inside the window with a unique match is counted', () => {
    const context: VersionContext = {
      sessionVersion: '1.3.4',
      sessionCreatedMs: Date.parse('2026-03-29T00:00:00Z'),
      messageCreatedMs: Date.parse('2026-03-29T12:00:00Z'),
    };
    const result = resolveV1Tokens(tokens(100, 60, 20, 400, 0, 560), context);
    expect(result).toEqual({ counts: expect.objectContaining({ inputTokens: 100, outputTokens: 60 }) });
  });

  it('CR + CW === 0 inside the window: all candidates agree, counted', () => {
    const context: VersionContext = {
      sessionVersion: '1.3.4',
      sessionCreatedMs: Date.parse('2026-03-29T00:00:00Z'),
      messageCreatedMs: Date.parse('2026-03-29T12:00:00Z'),
    };
    const result = resolveV1Tokens(tokens(100, 50, 0, 0, 0, 150), context);
    expect(result).toEqual({ counts: expect.objectContaining({ inputTokens: 100, outputTokens: 50 }) });
  });
});

describe('parseStoredTokens', () => {
  it('returns null when input is missing', () => {
    expect(parseStoredTokens({ output: 5 })).toBeNull();
  });

  it('returns null when cache.read is negative', () => {
    expect(parseStoredTokens({ input: 10, output: 5, cache: { read: -1, write: 0 } })).toBeNull();
  });

  it('defaults missing reasoning/cache/total to 0/0/null', () => {
    expect(parseStoredTokens({ input: 10, output: 5 })).toEqual({
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: null,
    });
  });

  it('returns null for a non-integer counter', () => {
    expect(parseStoredTokens({ input: 1.5, output: 5 })).toBeNull();
  });

  it('returns null for a non-finite counter', () => {
    expect(parseStoredTokens({ input: Number.NaN, output: 5 })).toBeNull();
    expect(parseStoredTokens({ input: 10, output: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('returns null when the raw value itself is an array', () => {
    expect(parseStoredTokens([1, 2, 3])).toBeNull();
  });

  it('parses an explicit total: null the same as an absent total', () => {
    expect(parseStoredTokens({ input: 10, output: 5, total: null })).toEqual({
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: null,
    });
  });
});

describe('compareVersions', () => {
  it('compares plain x.y.z versions numerically, not lexically', () => {
    expect(compareVersions('1.3.16', '1.3.6')).toBeGreaterThan(0);
    expect(compareVersions('1.18.32', '1.3.16')).toBeGreaterThan(0);
    expect(compareVersions('1.3.6', '1.3.6')).toBe(0);
  });

  it('returns null when either side is not a plain x.y.z version', () => {
    expect(compareVersions('0.0.0-dev-1', '1.3.6')).toBeNull();
    expect(compareVersions('local', '1.0.0')).toBeNull();
  });
});

describe('resolveV2Tokens', () => {
  it('folds reasoning into output, cache split preserved, no total needed', () => {
    const result = resolveV2Tokens(tokens(10, 5, 3, 7, 2, null));
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cacheCreationTokens: 2,
      cacheReadTokens: 7,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    });
  });
});
