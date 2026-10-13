import { familyForMaker, type Maker, type ModelFamily } from '../model-makers.js';

export { modelLabel } from '../models.js';

/** Graph levels by rank within a family: the heaviest model gets the deepest shade; levels are spread wide enough to tell apart. */
const SHADE_LEVELS = [5, 3, 2] as const;

/** The colour of the model at `rankInFamily` (0 is the heaviest) of `family`; ranks past the shades (the 4th model on) reuse level 2. */
export function familyShade(family: ModelFamily, rankInFamily: number): string {
  const level = SHADE_LEVELS[Math.min(rankInFamily, SHADE_LEVELS.length - 1)]!;
  return `var(--graph-${family}-${level})`;
}

/** The colour a model shows when none was assigned: the first shade of the "other" family. */
export const OTHER_COLOR = familyShade('other', 0);

/**
 * Colours say which family a model belongs to, the same hue as the graph; heavier models of a
 * family get the deeper shade. Models are given heaviest first, and rank is counted per family.
 */
export function modelColors(models: readonly { label: string; maker: Maker | null }[]): Map<string, string> {
  const colors = new Map<string, string>();
  const ranks = new Map<ModelFamily, number>();
  for (const { label, maker } of models) {
    if (colors.has(label)) continue;
    const family = familyForMaker(maker);
    const rank = ranks.get(family) ?? 0;
    ranks.set(family, rank + 1);
    colors.set(label, familyShade(family, rank));
  }
  return colors;
}
