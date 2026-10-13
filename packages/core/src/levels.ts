export type Level = 0 | 1 | 2 | 3 | 4 | 5;

/** Four cut points split non-zero days into levels 1-5; level 0 means no activity. */
export type Thresholds = readonly [number, number, number, number];

export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  if (sortedAscending.length === 1) return sortedAscending[0]!;
  const rank = (sortedAscending.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAscending[lower]!;
  return sortedAscending[lower]! + (sortedAscending[upper]! - sortedAscending[lower]!) * (rank - lower);
}

/**
 * Cut points at the 20th, 40th, 60th and 80th percentile of the person's own non-zero days.
 * Fixed thresholds would leave a light user's year uniformly level 1 and a heavy user's
 * uniformly level 5; quantiles give everyone the same spread across their own history.
 */
export function computeThresholds(values: readonly number[]): Thresholds {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  return [
    percentile(nonZero, 0.2),
    percentile(nonZero, 0.4),
    percentile(nonZero, 0.6),
    percentile(nonZero, 0.8),
  ];
}

export function levelFor(value: number, thresholds: Thresholds): Level {
  if (value <= 0) return 0;
  if (value < thresholds[0]) return 1;
  if (value < thresholds[1]) return 2;
  if (value < thresholds[2]) return 3;
  if (value < thresholds[3]) return 4;
  return 5;
}
