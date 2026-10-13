import type { PricingTier } from './pricing-tiers.js';
import type { KnownSource } from './sources.js';
import type { SplitTokenCounts } from './tokens.js';

/** One source's usage for one model, at one pricing tier, on one calendar day. */
export interface DailyModelUsage {
  date: string;
  model: string;
  pricingTier: PricingTier;
  counts: SplitTokenCounts;
}

export interface CollectResult {
  source: KnownSource;
  usage: DailyModelUsage[];
  /** Distinct upstream API requests seen, for sanity-checking a collection run. */
  requestCount: number;
  /** Human-readable caveats about this run (skipped or approximated records), printed by sync. */
  notes?: string[];
}

export interface Adapter {
  name: string;
  detect(): Promise<boolean>;
  collect(since: Date): Promise<CollectResult>;
}
