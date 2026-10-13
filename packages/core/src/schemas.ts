import { z } from 'zod';
import { isDateKey } from './dates.js';
import { PRICING_TIERS } from './pricing-tiers.js';
import { KNOWN_SOURCES } from './sources.js';

const tokenCount = z.number().int().min(0).max(1e12);

export const modelUsageSchema = z.object({
  model: z.string().min(1).max(120),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cacheReadTokens: tokenCount,
  // Optional, not nullable: older CLI versions never send these, and a payload that omits
  // them must still validate so a gradual client rollout does not break uploads.
  cacheCreation5mTokens: tokenCount.optional(),
  cacheCreation1hTokens: tokenCount.optional(),
  // Optional for the same gradual-rollout reason; a missing tier means standard.
  pricingTier: z.enum(PRICING_TIERS).optional(),
});

export const dayUsageSchema = z.object({
  date: z.string().refine(isDateKey, 'expected a YYYY-MM-DD calendar date'),
  models: z.array(modelUsageSchema).min(1).max(50),
});

export const usagePayloadSchema = z.object({
  deviceId: z.uuid(),
  source: z.enum(KNOWN_SOURCES),
  days: z.array(dayUsageSchema).min(1).max(400),
});

export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type DayUsage = z.infer<typeof dayUsageSchema>;
export type UsagePayload = z.infer<typeof usagePayloadSchema>;
