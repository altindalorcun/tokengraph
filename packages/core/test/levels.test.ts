import { describe, expect, it } from 'vitest';
import { computeThresholds, levelFor, percentile } from '../src/levels.js';

describe('percentile', () => {
  it('interpolates between neighbouring ranks', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it('returns the bounds at p0 and p100', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 1)).toBe(30);
  });

  it('returns 0 for an empty set', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('computeThresholds', () => {
  it('cuts at the 20th, 40th, 60th and 80th percentile', () => {
    expect(computeThresholds([100, 200, 300, 400, 500])).toEqual([180, 260, 340, 420]);
  });

  it('ignores zero days so idle days do not flatten the scale', () => {
    const withZeros = computeThresholds([0, 0, 0, 100, 200, 300, 400]);
    const withoutZeros = computeThresholds([100, 200, 300, 400]);
    expect(withZeros).toEqual(withoutZeros);
  });

  it('does not depend on input order', () => {
    expect(computeThresholds([400, 100, 300, 200])).toEqual(computeThresholds([100, 200, 300, 400]));
  });
});

describe('levelFor', () => {
  const thresholds = computeThresholds([100, 200, 300, 400, 500]);

  it('gives level 0 to days with no usage', () => {
    expect(levelFor(0, thresholds)).toBe(0);
  });

  it('spreads non-zero days across levels 1 to 5', () => {
    expect(levelFor(100, thresholds)).toBe(1);
    expect(levelFor(200, thresholds)).toBe(2);
    expect(levelFor(300, thresholds)).toBe(3);
    expect(levelFor(400, thresholds)).toBe(4);
    expect(levelFor(500, thresholds)).toBe(5);
  });

  it('never returns level 0 for a day with any usage', () => {
    expect(levelFor(1, thresholds)).toBe(1);
  });

  it('puts every day at the top level when usage is uniform', () => {
    const flat = computeThresholds([500, 500, 500]);
    expect(levelFor(500, flat)).toBe(5);
  });
});
