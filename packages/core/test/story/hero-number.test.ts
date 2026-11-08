import { describe, expect, it } from 'vitest';
import { formatTokens } from '../../src/graph.js';
import { heroNumber } from '../../src/story/format.js';

describe('heroNumber', () => {
  it('never prints "1000" of a unit: just under a billion is 1.0B', () => {
    expect(heroNumber(999_970_000)).toEqual({ figure: '1.0', unit: 'B' });
    expect(heroNumber(999_960)).toEqual({ figure: '1.0', unit: 'M' });
  });

  it('keeps the decimal the README graph shows', () => {
    expect(heroNumber(713_400_000)).toEqual({ figure: '713.4', unit: 'M' });
  });

  it('reads the same as formatTokens everywhere else', () => {
    for (const value of [0, 7, 999, 1_234, 48_240_000, 99_960_000, 713_400_000, 999_970_000, 3_100_000_000, 4.2e12, 7e18]) {
      const { figure, unit } = heroNumber(value);
      expect(figure + unit).toBe(formatTokens(value));
    }
  });
});
