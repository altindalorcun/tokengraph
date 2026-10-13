import { describe, expect, it } from 'vitest';
import {
  claudeLongContextThreshold,
  DEFAULT_PRICING_TIER,
  isPricingTier,
  LONG_CONTEXT_THRESHOLD_TOKENS,
  PRICING_TIERS,
  pricingTierFor,
} from '../src/pricing-tiers.js';

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

describe('claudeLongContextThreshold', () => {
  it('is 100K prompt tokens for Haiku 5.5, dated snapshot or not', () => {
    expect(claudeLongContextThreshold('claude-haiku-5-5')).toBe(100_000);
    expect(claudeLongContextThreshold('claude-haiku-5-5-20261001')).toBe(100_000);
  });

  it('is null for every Claude model that bills its whole context window at one rate', () => {
    expect(claudeLongContextThreshold('claude-opus-5-5')).toBeNull();
    expect(claudeLongContextThreshold('claude-haiku-4-5-20251001')).toBeNull();
    expect(claudeLongContextThreshold('gpt-6-sol')).toBeNull();
  });
});
