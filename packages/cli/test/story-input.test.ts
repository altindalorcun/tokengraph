import type { DailyModelUsage } from '@tokengraph/core';
import { buildStory } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { storyHandle, storyRows } from '../src/story/input.js';

const counts = (input: number, split: number | null) => ({
  inputTokens: input,
  outputTokens: 10,
  cacheCreationTokens: 4,
  cacheReadTokens: 100,
  cacheCreation5mTokens: split,
  cacheCreation1hTokens: split === null ? null : 0,
});

describe('storyRows', () => {
  it('sums one model-day across sources, tiers and machines; keeps tiers apart for cost', () => {
    const usage: DailyModelUsage[] = [
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(100, 4) },
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(50, 4) },
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'fast', counts: counts(5, 4) },
    ];
    const { rows, costRows } = storyRows(usage);
    expect(rows).toEqual([{ date: '2026-10-13', model: 'claude-opus-5-5', inputTokens: 155, outputTokens: 30, cacheCreationTokens: 12, cacheReadTokens: 300 }]);
    expect(costRows.map((row) => [row.pricingTier, row.inputTokens, row.cacheCreation5mTokens])).toEqual([
      ['standard', 150, 8],
      ['fast', 5, 4],
    ]);
  });

  it('an unknown cache split stays unknown when summed', () => {
    const { costRows } = storyRows([
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(1, 4) },
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(1, null) },
    ]);
    expect(costRows[0]!.cacheCreation5mTokens).toBeNull();
  });

  it('feeds buildStory with totals that match the graph rule (weight per day, then sum)', () => {
    const { rows, costRows } = storyRows([{ date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(1000, 4) }]);
    const story = buildStory({ handle: 'octocat', range: 'today', todayUtc: '2026-10-13', rows, costRows });
    expect(story.total).toBe(1000 + 10 + 4 + 10);
  });

  it('builds an empty story without crashing', () => {
    const story = buildStory({ handle: 'octocat', range: '7d', todayUtc: '2026-10-13', ...storyRows([]) });
    expect(story.total).toBe(0);
  });
});

describe('storyHandle', () => {
  it('prefers --handle, then the GitHub login, then the OS user', () => {
    expect(storyHandle({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } } }, 'me', 'os')).toBe('me');
    expect(storyHandle({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } } }, undefined, 'os')).toBe('octocat');
    expect(storyHandle({}, undefined, 'os')).toBe('os');
    expect(storyHandle({}, '@me', 'os')).toBe('me');
  });
});
