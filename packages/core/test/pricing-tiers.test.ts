import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICING_TIER,
  isPricingTier,
  LONG_CONTEXT_THRESHOLD_TOKENS,
  PRICING_TIERS,
  pricingTierFor,
} from '../src/pricing-tiers.js';
import { longContextThreshold } from '../src/pricing.js';

describe('pricingTierFor', () => {
  it('is standard for a normal request', () => {
    expect(pricingTierFor({ fast: false, inputTokens: 1000 })).toBe('standard');
  });

  it('treats the threshold itself as short context and one token over as long', () => {
    expect(LONG_CONTEXT_THRESHOLD_TOKENS).toBe(272_000);
    expect(pricingTierFor({ fast: false, inputTokens: 272_000 })).toBe('standard');
    expect(pricingTierFor({ fast: false, inputTokens: 272_001 })).toBe('long-context');
  });

  it('combines fast mode with long context', () => {
    expect(pricingTierFor({ fast: true, inputTokens: 10 })).toBe('fast');
    expect(pricingTierFor({ fast: true, inputTokens: 300_000 })).toBe('fast-long-context');
  });
});

describe('isPricingTier', () => {
  it('accepts every known tier and rejects anything else', () => {
    for (const tier of PRICING_TIERS) expect(isPricingTier(tier)).toBe(true);
    expect(isPricingTier('priority')).toBe(false);
    expect(DEFAULT_PRICING_TIER).toBe('standard');
  });
});

describe('longContextThreshold', () => {
  it('is 100K prompt tokens for Haiku 5.5, dated snapshot or not', () => {
    expect(longContextThreshold('claude-haiku-5-5')).toBe(100_000);
    expect(longContextThreshold('claude-haiku-5-5-20261001')).toBe(100_000);
  });

  it('is 200K for Gemini and xAI models that publish a long-context rate, 272K for OpenAI', () => {
    expect(longContextThreshold('gemini-2.5-pro')).toBe(200_000);
    expect(longContextThreshold('gemini-3.1-pro-preview-customtools')).toBe(200_000);
    expect(longContextThreshold('grok-4.7')).toBe(200_000);
    expect(longContextThreshold('gpt-5.4')).toBe(272_000);
    expect(longContextThreshold('gpt-6-sol')).toBe(272_000);
  });

  it('is null for every model that bills its whole context window at one rate', () => {
    expect(longContextThreshold('claude-opus-5-5')).toBeNull();
    expect(longContextThreshold('claude-haiku-4-5-20251001')).toBeNull();
    expect(longContextThreshold('gemini-2.5-flash')).toBeNull();
    expect(longContextThreshold('composer-2.5')).toBeNull();
  });

  it('keeps the OpenAI threshold for a gpt- id without long-context rates, known or not, so its long requests stay apart', () => {
    expect(longContextThreshold('gpt-5.4-mini')).toBe(272_000);
    expect(longContextThreshold('gpt-9-future')).toBe(272_000);
  });
});

describe('pricingTierFor with a given threshold', () => {
  it('uses the threshold it is given', () => {
    expect(pricingTierFor({ fast: false, inputTokens: 200_001, thresholdTokens: 200_000 })).toBe('long-context');
    expect(pricingTierFor({ fast: false, inputTokens: 200_000, thresholdTokens: 200_000 })).toBe('standard');
    expect(pricingTierFor({ fast: true, inputTokens: 200_001, thresholdTokens: 200_000 })).toBe('fast-long-context');
  });
});
