import * as core from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without types
import { buildLanding } from '../../../scripts/samples-landing.mjs';

describe('landing.json', () => {
  const landing = buildLanding(core, { referenceDate: '2026-10-11', handle: 'octocat' });

  it('has every key the site reads', () => {
    expect(Object.keys(landing).sort()).toEqual(
      ['dayModels', 'families', 'grid', 'handle', 'logos', 'paletteCss', 'recentBars', 'referenceDate', 'schema', 'stats'].sort(),
    );
    expect(landing.schema).toBe(1);
    expect(landing.grid.columns).toHaveLength(core.WEEKS);
    expect(landing.recentBars).toHaveLength(14);
    expect(landing.paletteCss).toContain('--graph-claude-4:');
    expect(landing.paletteCss).toContain('prefers-color-scheme:dark');
    expect(Object.keys(landing.logos.agents)).toContain('claude-code');
  });

  it('agrees with the graph: total equals the grid total, shares sum to 1', () => {
    expect(landing.stats.total).toBe(landing.grid.total);
    expect(landing.families.reduce((sum: number, f: { share: number }) => sum + f.share, 0)).toBeCloseTo(1, 6);
  });

  it('is reproducible', () => {
    expect(JSON.stringify(buildLanding(core, { referenceDate: '2026-10-11', handle: 'octocat' }))).toBe(JSON.stringify(landing));
  });
});
