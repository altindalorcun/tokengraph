import { describe, expect, it } from 'vitest';
import { PUBLISHED_GRAPH_FILES, renderPublishedGraphs } from '../src/published-graphs.js';
import type { DailyModelUsage } from '../src/types.js';

const counts = { inputTokens: 1_000_000, outputTokens: 20_000, cacheCreationTokens: 0, cacheReadTokens: 5_000_000, cacheCreation5mTokens: null, cacheCreation1hTokens: null };
const usage: DailyModelUsage[] = [
  { date: '2026-10-10', model: 'claude-opus-5-5', pricingTier: 'standard', counts },
  { date: '2026-10-11', model: 'gpt-5.5', pricingTier: 'standard', counts },
];

describe('renderPublishedGraphs', () => {
  it('renders the four files', () => {
    const files = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    expect(Object.keys(files).sort()).toEqual([...PUBLISHED_GRAPH_FILES].sort());
    for (const svg of Object.values(files)) expect(svg.startsWith('<svg')).toBe(true);
  });

  it('is deterministic', () => {
    const a = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    const b = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    expect(a).toEqual(b);
  });

  it('never exposes model ids', () => {
    const files = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    for (const svg of Object.values(files)) {
      expect(svg).not.toContain('claude-opus-5-5');
      expect(svg).not.toContain('gpt-5.5');
    }
  });

  it('embeds the font so the SVG renders inside an <img>', () => {
    expect(renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'single' })['tokengraph-light.svg']).toContain('@font-face');
  });

  it('draws an empty graph with a title instead of failing', () => {
    expect(renderPublishedGraphs([], { today: '2026-10-13', colors: 'model' })['tokengraph-dark.svg']).toContain('No tokens synced yet');
  });
});
