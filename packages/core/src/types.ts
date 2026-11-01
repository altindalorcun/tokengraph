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

/** Usage of one working folder: the same requests as `usage`, split by where they ran. */
export interface ProjectUsage extends DailyModelUsage {
  /** As the agent recorded it. Local only, like hours: never in a machine file or a gist. */
  folder: string;
}

/** Weighted tokens of one source in one local hour (0-23) of one day. Display-only; never priced. */
export interface HourlyUsage {
  date: string;
  hour: number;
  weighted: number;
}

export interface CollectResult {
  source: KnownSource;
  usage: DailyModelUsage[];
  /** Distinct upstream API requests seen, for sanity-checking a collection run. */
  requestCount: number;
  /**
   * Weighted tokens per (date, hour), summed over requests (each request weighted on its own, which is
   * fine because hours are display-only). Hour is the local hour in the same zone as `date`. Absent when
   * the source has no per-request time.
   */
  hours?: HourlyUsage[];
  /** Usage per working folder. A request with no known folder is left out, so this may sum to less than `usage`. */
  projects?: ProjectUsage[];
  /** Human-readable caveats about this run (skipped or approximated records), printed by sync. */
  notes?: string[];
}

export interface Adapter {
  name: string;
  detect(): Promise<boolean>;
  collect(since: Date): Promise<CollectResult>;
}
