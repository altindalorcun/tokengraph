/**
 * The shareable story images: what can be asked for and how big each one is. Pure, so the route,
 * the share page and the tests agree on one list.
 */

export const STORY_TEMPLATES = ['skyline', 'receipt', 'sticker'] as const;
export type StoryTemplate = (typeof STORY_TEMPLATES)[number];

export const STORY_TEMPLATE_LABELS: Record<StoryTemplate, { name: string; blurb: string }> = {
  skyline: { name: 'Skyline', blurb: 'Your last weeks as a city of towers, today lit up.' },
  receipt: { name: 'Receipt', blurb: 'Every model on the bill, cache reads at a tenth.' },
  sticker: { name: 'Sticker', blurb: 'Transparent. Drop it on a photo of your desk.' },
};

/** The periods a card can cover; there is no all-time, which has no fixed span to name on a card. */
export const STORY_RANGES = ['today', '7d', '30d', '1y'] as const;
export type StoryRange = (typeof STORY_RANGES)[number];

export const STORY_RANGE_LABELS: Record<StoryRange, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  // Not "Year": a rolling 365 days, not a calendar year.
  '1y': '12 months',
};

/** Full-bleed cards are a story frame (9:16); the sticker is cropped to its content so it pastes as a sticker. */
export const STORY_SIZES: Record<StoryTemplate, { width: number; height: number }> = {
  skyline: { width: 1080, height: 1920 },
  receipt: { width: 1080, height: 1920 },
  sticker: { width: 1080, height: 1380 },
};

export interface StoryOptions {
  template: StoryTemplate;
  range: StoryRange;
  /** Whether the estimated API cost is printed. Some people would rather not post a dollar figure. */
  showCost: boolean;
}

export const DEFAULT_STORY_OPTIONS: StoryOptions = { template: 'skyline', range: 'today', showCost: true };

/** "tokengraph-octocat-2026-10-11-skyline.png": who, which day the period ends, which card. */
export function storyFileName(handle: string, endDate: string, options: StoryOptions): string {
  const span = options.range === 'today' ? '' : `-${options.range}`;
  return `tokengraph-${handle}-${endDate}${span}-${options.template}.png`;
}
