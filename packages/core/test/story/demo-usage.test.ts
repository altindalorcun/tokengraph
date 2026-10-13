import { describe, expect, it } from 'vitest';
import { DEMO_HANDLE, demoUsage } from '../../src/story/demo-usage.js';
import { modelMaker } from '../../src/model-makers.js';

describe('demoUsage', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const demo = demoUsage(now);

  it('is deterministic, so the landing page does not flicker between renders', () => {
    expect(demoUsage(now)).toEqual(demo);
  });

  it('plays as GitHub’s example account, not a real user', () => {
    expect(DEMO_HANDLE).toBe('octocat');
  });

  it('spreads the year across the companies behind its models', () => {
    const makers = new Set(demo.modelRows.map((entry) => modelMaker(entry.model)));
    for (const maker of ['anthropic', 'openai', 'google', 'deepseek', 'qwen', 'moonshot', 'zhipu']) expect(makers).toContain(maker);
    const families = new Set(demo.days.map((day) => day.topFamily));
    for (const family of ['claude', 'gpt', 'gemini', 'deepseek', 'qwen', 'glm', 'kimi']) expect(families).toContain(family);
  });

  it('ends on the given day and builds its graph days from the per-model rows', () => {
    expect(demo.endDate).toBe('2026-10-02');
    expect(demo.days.length).toBeGreaterThan(100);
    expect(new Set(demo.modelRows.map((entry) => entry.date)).size).toBe(demo.days.length);
  });
});
