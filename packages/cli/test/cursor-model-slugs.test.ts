import { findRate } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { cursorModelIdentity, normalizeCursorModel } from '../src/adapters/cursor/aggregator.js';

/**
 * Every distinct model slug in the sampled Cursor usage exports, with the id it is stored and
 * priced under and the tier: `priced` is the id when a vendor list price exists for that id and
 * tier, `null` when the model stays unpriced (never a guess, never $0).
 */
const SLUGS: ReadonlyArray<readonly [slug: string, model: string, tier: 'standard' | 'fast', priced: boolean]> = [
  ['auto', 'auto', 'standard', false],
  ['agent_review', 'agent_review', 'standard', false],
  ['Premium (Codex 5.3)', 'Premium (Codex 5.3)', 'standard', false],
  ['claude-4.5-opus-high-thinking', 'claude-opus-4-5', 'standard', true],
  ['claude-4.5-opus-high', 'claude-opus-4-5', 'standard', true],
  ['claude-4-sonnet-thinking', 'claude-sonnet-4', 'standard', true],
  ['claude-4-sonnet', 'claude-sonnet-4', 'standard', true],
  ['claude-4.5-sonnet', 'claude-sonnet-4-5', 'standard', true],
  ['claude-4.5-sonnet-thinking', 'claude-sonnet-4-5', 'standard', true],
  ['claude-4.5-haiku-thinking', 'claude-haiku-4-5', 'standard', true],
  ['claude-4.6-opus-max-thinking', 'claude-opus-4-6', 'standard', true],
  ['claude-4.6-opus-high-thinking', 'claude-opus-4-6', 'standard', true],
  ['claude-4.6-opus-medium-thinking', 'claude-opus-4-6', 'standard', true],
  ['claude-4.6-opus-low-thinking', 'claude-opus-4-6', 'standard', true],
  ['claude-4.6-sonnet-medium-thinking', 'claude-sonnet-4-6', 'standard', true],
  ['claude-opus-4-7-thinking-high', 'claude-opus-4-7', 'standard', true],
  ['claude-opus-4-7-thinking-medium', 'claude-opus-4-7', 'standard', true],
  ['claude-opus-4-7-thinking-xhigh', 'claude-opus-4-7', 'standard', true],
  ['claude-opus-4-8-thinking-high', 'claude-opus-4-8', 'standard', true],
  ['claude-opus-4-8-thinking-medium', 'claude-opus-4-8', 'standard', true],
  ['claude-fable-5-thinking-high', 'claude-fable-5', 'standard', true],
  ['claude-sonnet-5-thinking-high', 'claude-sonnet-5', 'standard', true],
  // Retired and no longer on Anthropic's price page.
  ['claude-3.5-sonnet', 'claude-3-5-sonnet', 'standard', false],
  ['composer-2.5', 'composer-2.5', 'standard', true],
  ['composer-2.5-fast', 'composer-2.5-fast', 'standard', true],
  // Cache-read price not published; retired with no published price.
  ['composer-2', 'composer-2', 'standard', false],
  ['composer-2-fast', 'composer-2-fast', 'standard', false],
  ['composer-1', 'composer-1', 'standard', false],
  ['composer-1.5', 'composer-1.5', 'standard', false],
  ['gpt-5.5-medium', 'gpt-5.5', 'standard', true],
  ['gpt-5.5-high', 'gpt-5.5', 'standard', true],
  ['gpt-5.5-extra-high', 'gpt-5.5', 'standard', true],
  ['gpt-5.5-low', 'gpt-5.5', 'standard', true],
  ['gpt-5.5-none', 'gpt-5.5', 'standard', true],
  ['gpt-5.5-extra-high-fast', 'gpt-5.5', 'fast', true],
  ['gpt-5.5-none-fast', 'gpt-5.5', 'fast', true],
  ['gpt-5.4-medium', 'gpt-5.4', 'standard', true],
  ['gpt-5.4-high', 'gpt-5.4', 'standard', true],
  ['gpt-5.3-codex', 'gpt-5.3-codex', 'standard', true],
  ['gpt-5.3-codex-high', 'gpt-5.3-codex', 'standard', true],
  ['gpt-5.3-codex-high-fast', 'gpt-5.3-codex', 'fast', true],
  // OpenAI publishes no fast row for the other codex models.
  ['gpt-5.2-codex-xhigh-fast', 'gpt-5.2-codex', 'fast', false],
  ['gpt-5.1-codex', 'gpt-5.1-codex', 'standard', true],
  ['gpt-5.1-codex-high', 'gpt-5.1-codex', 'standard', true],
  ['gpt-5.1-codex-mini', 'gpt-5.1-codex-mini', 'standard', true],
  ['gpt-5-codex', 'gpt-5-codex', 'standard', true],
  ['gpt-5-codex-high', 'gpt-5-codex', 'standard', true],
  ['gpt-5', 'gpt-5', 'standard', true],
  ['gpt-5-fast', 'gpt-5', 'fast', true],
  ['gpt-4.1', 'gpt-4.1', 'standard', true],
  ['gpt-4.1-mini', 'gpt-4.1-mini', 'standard', true],
  ['o3', 'o3', 'standard', true],
  ['o3-mini', 'o3-mini', 'standard', true],
  ['cursor-grok-4.5-medium', 'grok-4.5', 'standard', true],
  ['grok-4.3', 'grok-4.3', 'standard', true],
  // Retired, no published price; a preview id is never priced as its successor.
  ['grok-3-beta', 'grok-3-beta', 'standard', false],
  ['gemini-3-pro-preview', 'gemini-3-pro-preview', 'standard', false],
  ['gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-05-06', 'standard', false],
];

describe('every sampled Cursor slug', () => {
  it.each(SLUGS)('%s is stored as %s (%s) and is priced: %s', (slug, model, tier, priced) => {
    const identity = cursorModelIdentity({ model: slug, modelId: slug, fast: false });
    // composer-N-fast is its own model with its own rates; every other fast slug is the same model at the fast tier.
    expect(identity).toEqual({ model, pricingTier: tier === 'fast' ? 'fast' : 'standard' });
    const rate = findRate(identity.model, '2026-10-21');
    const fastOk = identity.pricingTier !== 'fast' || (rate !== null && rate.fastMultiplier !== null);
    expect(rate !== null && fastOk).toBe(priced);
  });

  it('covers each distinct slug once', () => {
    expect(new Set(SLUGS.map(([slug]) => slug)).size).toBe(SLUGS.length);
  });
});

describe('normalizeCursorModel for non-Claude slugs', () => {
  it('lowercases and trims', () => {
    expect(normalizeCursorModel('  GPT-5.5-High ')).toBe('gpt-5.5');
    expect(normalizeCursorModel('Composer-2.5')).toBe('composer-2.5');
  });

  it('strips an effort word on gpt-, grok- and o-series ids only', () => {
    expect(normalizeCursorModel('gpt-5.2-xhigh')).toBe('gpt-5.2');
    expect(normalizeCursorModel('gpt-5-minimal')).toBe('gpt-5');
    expect(normalizeCursorModel('o3-mini-high')).toBe('o3-mini');
    expect(normalizeCursorModel('grok-4.7-low')).toBe('grok-4.7');
    expect(normalizeCursorModel('gemini-2.5-pro-high')).toBe('gemini-2.5-pro-high');
    expect(normalizeCursorModel('composer-2.5-high')).toBe('composer-2.5-high');
  });

  it('keeps max, codex, mini and nano: they are models, not efforts', () => {
    for (const id of ['gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5.5-pro']) {
      expect(normalizeCursorModel(id)).toBe(id);
    }
  });

  it('strips the cursor- prefix, also on Claude slugs', () => {
    expect(normalizeCursorModel('cursor-grok-4.5-medium')).toBe('grok-4.5');
    expect(normalizeCursorModel('cursor-claude-4.5-sonnet-thinking')).toBe('claude-sonnet-4-5');
  });

  it('leaves display labels and router slugs exactly as sent', () => {
    expect(normalizeCursorModel('Premium (Codex 5.3)')).toBe('Premium (Codex 5.3)');
    expect(normalizeCursorModel('auto')).toBe('auto');
    expect(normalizeCursorModel('agent_review')).toBe('agent_review');
  });
});
