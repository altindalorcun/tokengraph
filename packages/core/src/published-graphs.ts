import { addDays, dateKey } from './dates.js';
import { EMBED_FONT_FACE_CSS } from './embed-font.js';
import { renderGraphSvg, type ColorMode, type Theme } from './graph.js';
import { GRAPH_WINDOW_DAYS, graphEndDate, toGraphDaysByFamily, usageToModelRows } from './graph-days.js';
import type { DailyModelUsage } from './types.js';

export const PUBLISHED_GRAPH_FILES = [
  'tokengraph-dark.svg',
  'tokengraph-light.svg',
  'tokengraph-compact-dark.svg',
  'tokengraph-compact-light.svg',
] as const;
export type PublishedGraphFile = (typeof PUBLISHED_GRAPH_FILES)[number];
export type GraphColorsSetting = 'model' | 'single';

const VARIANTS: Record<PublishedGraphFile, { theme: Theme; compact: boolean }> = {
  'tokengraph-dark.svg': { theme: 'dark', compact: false },
  'tokengraph-light.svg': { theme: 'light', compact: false },
  'tokengraph-compact-dark.svg': { theme: 'dark', compact: true },
  'tokengraph-compact-light.svg': { theme: 'light', compact: true },
};

/**
 * The README graph as published to the graph gist: the year ending today, summed over every
 * machine's usage. Deterministic for the same input and day, so an unchanged graph is never
 * re-uploaded. Only family colours and names reach the SVG, never model ids.
 */
export function renderPublishedGraphs(
  usage: readonly DailyModelUsage[],
  options: { today: string; colors: GraphColorsSetting },
): Record<PublishedGraphFile, string> {
  const since = dateKey(addDays(new Date(`${options.today}T12:00:00Z`), -GRAPH_WINDOW_DAYS), 'UTC');
  const days = toGraphDaysByFamily(usageToModelRows(usage.filter((entry) => entry.date >= since)));
  const endDate = graphEndDate(options.today, days.map((day) => day.date));
  const colorMode: ColorMode = options.colors === 'single' ? 'single' : 'per-model';
  const files = {} as Record<PublishedGraphFile, string>;
  for (const file of PUBLISHED_GRAPH_FILES) {
    const { theme, compact } = VARIANTS[file];
    files[file] = renderGraphSvg(days, {
      endDate,
      theme,
      compact,
      colorMode,
      fontFaceCss: EMBED_FONT_FACE_CSS,
      title: days.length === 0 ? 'No tokens synced yet' : undefined,
    });
  }
  return files;
}
