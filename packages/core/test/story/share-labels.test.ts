import { describe, expect, it } from 'vitest';
import { shareLabel, shareLabels } from '../../src/story/index.js';

describe('shareLabels', () => {
  it('adds up to 100% where rounding each share would make 101%', () => {
    const shares = [0.297, 0.276, 0.265, 0.068, 0.054, 0.04];
    expect(shares.map(shareLabel)).toEqual(['30%', '28%', '27%', '7%', '5%', '4%']);
    expect(shareLabels(shares)).toEqual(['30%', '28%', '26%', '7%', '5%', '4%']);
  });

  it('keeps "<1%" for a real share that rounds to nothing', () => {
    expect(shareLabels([0.996, 0.004])).toEqual(['100%', '<1%']);
  });

  it('gives the leftover points to the largest remainders, the earlier one on a tie', () => {
    expect(shareLabels([1 / 3, 1 / 3, 1 / 3])).toEqual(['34%', '33%', '33%']);
  });

  it('reads an empty whole as zero', () => {
    expect(shareLabels([0, 0])).toEqual(['0%', '0%']);
  });
});
