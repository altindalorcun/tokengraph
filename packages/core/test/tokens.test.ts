import { describe, expect, it } from 'vitest';
import { addCounts, addSplitCounts, emptyCounts, emptySplitCounts, maxNullable, maxSplitCounts, weightedTokens } from '../src/tokens.js';

describe('weightedTokens', () => {
  it('counts fresh tokens at full weight', () => {
    expect(
      weightedTokens({
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationTokens: 300,
        cacheReadTokens: 0,
      }),
    ).toBe(600);
  });

  it('discounts cache reads to a tenth', () => {
    expect(
      weightedTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 1000,
      }),
    ).toBe(100);
  });

  it('keeps a real request from being swamped by its cache reads', () => {
    // Shape taken from an observed Claude Code request.
    const weighted = weightedTokens({
      inputTokens: 2,
      outputTokens: 2069,
      cacheCreationTokens: 1726,
      cacheReadTokens: 251557,
    });
    const raw = 2 + 2069 + 1726 + 251557;
    expect(weighted).toBe(3797 + 25156);
    expect(weighted).toBeLessThan(raw / 8);
  });
});

describe('addCounts', () => {
  it('sums field by field', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 };
    expect(addCounts(a, a)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 6,
      cacheReadTokens: 8,
    });
  });

  it('leaves counts unchanged when adding an empty set', () => {
    const a = { inputTokens: 5, outputTokens: 6, cacheCreationTokens: 7, cacheReadTokens: 8 };
    expect(addCounts(a, emptyCounts())).toEqual(a);
  });
});

describe('maxNullable', () => {
  it('stays null when both sides are unknown', () => {
    expect(maxNullable(null, null)).toBeNull();
  });

  it('takes the known side when only one is unknown', () => {
    expect(maxNullable(null, 5)).toBe(5);
    expect(maxNullable(5, null)).toBe(5);
  });

  it('takes the larger of two known values', () => {
    expect(maxNullable(3, 9)).toBe(9);
  });
});

describe('addSplitCounts', () => {
  it('sums the base fields and the split fields alike', () => {
    const a = { ...emptySplitCounts(), inputTokens: 1, cacheCreation5mTokens: 10, cacheCreation1hTokens: 20 };
    const b = { ...emptySplitCounts(), inputTokens: 2, cacheCreation5mTokens: 5, cacheCreation1hTokens: 0 };
    const sum = addSplitCounts(a, b);
    expect(sum.inputTokens).toBe(3);
    expect(sum.cacheCreation5mTokens).toBe(15);
    expect(sum.cacheCreation1hTokens).toBe(20);
  });

  it('keeps a split field null only when neither side has a known value', () => {
    const unknown = emptySplitCounts();
    unknown.cacheCreation5mTokens = null;
    unknown.cacheCreation1hTokens = null;
    expect(addSplitCounts(unknown, unknown).cacheCreation5mTokens).toBeNull();

    const known = { ...emptySplitCounts(), cacheCreation5mTokens: 7 };
    expect(addSplitCounts(unknown, known).cacheCreation5mTokens).toBe(7);
  });
});

describe('maxSplitCounts', () => {
  it('takes the larger of each base field independently', () => {
    const a = { ...emptySplitCounts(), inputTokens: 10, outputTokens: 3 };
    const b = { ...emptySplitCounts(), inputTokens: 4, outputTokens: 9 };
    expect(maxSplitCounts(a, b)).toMatchObject({ inputTokens: 10, outputTokens: 9 });
  });

  it('is null-aware for the split fields, like maxNullable', () => {
    const a = { ...emptySplitCounts(), cacheCreation5mTokens: null, cacheCreation1hTokens: 3 };
    const b = { ...emptySplitCounts(), cacheCreation5mTokens: null, cacheCreation1hTokens: null };
    const max = maxSplitCounts(a, b);
    expect(max.cacheCreation5mTokens).toBeNull();
    expect(max.cacheCreation1hTokens).toBe(3);
  });
});
