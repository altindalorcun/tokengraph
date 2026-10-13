import type { StoryData } from '@tokengraph/core';

export interface CardContext {
  data: StoryData;
  showCost: boolean;
  /** What the card tells people to run: `npx tokengraph`. */
  cta: string;
}

/**
 * Instagram and TikTok draw their own UI over the top and bottom ~14% of a 1920px story (progress
 * bar and author up top, reply box and buttons below). Anything that has to be read sits between.
 */
export const SAFE_TOP = 250;
export const SAFE_BOTTOM = 1670;

/** The call to action every card carries. */
export const STORY_CTA = 'npx tokengraph';
