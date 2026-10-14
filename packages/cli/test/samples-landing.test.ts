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

  it('describes the graph window: family weights add up to the grid total', () => {
    const sum = landing.families.reduce((total: number, f: { weighted: number }) => total + f.weighted, 0);
    expect(Math.abs(sum - landing.grid.total)).toBeLessThan(1000);
  });

  it('ships the palette the site relies on', () => {
    const css: string = landing.paletteCss;
    expect(css.startsWith(':root{')).toBe(true);
    expect(css).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme=\'light\']){');
    expect(css).toContain(':root[data-theme=\'dark\']{');
    const [light, dark] = [css.slice(0, css.indexOf('@media')), css.slice(css.indexOf(':root[data-theme=\'dark\']'))];
    expect(light).toContain(`--graph-claude-0:${core.DISPLAY_SURFACES.light.empty};`);
    expect(dark).toContain(`--graph-claude-0:${core.DISPLAY_SURFACES.dark.empty};`);
  });

  it('keeps day details small and sane', () => {
    const days = Object.values(landing.dayModels) as { share: number }[][];
    expect(days.length).toBeGreaterThan(0);
    for (const models of days) {
      expect(models.length).toBeGreaterThan(0);
      expect(models.length).toBeLessThanOrEqual(4);
      for (const model of models) {
        expect(model.share).toBeGreaterThan(0);
        expect(model.share).toBeLessThanOrEqual(1);
      }
    }
  });

  it('inlines every logo as svg markup', () => {
    for (const svg of Object.values(landing.logos.families) as string[]) expect(svg.startsWith('<svg')).toBe(true);
    for (const agent of Object.values(landing.logos.agents) as { svg: string }[]) expect(agent.svg.startsWith('<svg')).toBe(true);
  });

  it('is reproducible', () => {
    expect(JSON.stringify(buildLanding(core, { referenceDate: '2026-10-11', handle: 'octocat' }))).toBe(JSON.stringify(landing));
  });
});
