import {
  addSplitCounts,
  dateKey,
  emptySplitCounts,
  maxSplitCounts,
  PRICING_TIERS,
  type CollectResult,
  type KnownSource,
  type PricingTier,
  type SplitTokenCounts,
} from '@tokengraph/core';
import { tierForModel } from '../request-buckets.js';

/** Locally generated assistant messages (API errors, interrupts) — never real API usage. */
const SYNTHETIC_MODEL = '<synthetic>';

export interface AggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface Aggregated {
  date: string;
  model: string;
  /** Decided per request: fast mode from usage.speed, long context from the prompt length (Haiku 5.5). */
  pricingTier: PricingTier;
  counts: SplitTokenCounts;
}

/** One message.id's resolved usage — merged across every copy seen for that id. */
interface MessageRecord {
  date: string;
  model: string;
  /** usage.speed was "fast" on a copy of this message. */
  fast: boolean;
  counts: SplitTokenCounts;
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Claude Code writes the same assistant message to the transcript once per streaming
 * update. These copies do not carry identical usage: Claude Code writes a growing
 * snapshot as generation proceeds — output_tokens in particular can be 0 or far short
 * of the final count on an early copy — with only the *last* copy holding the true,
 * complete totals. Summing every line inflates totals; keeping whichever copy is seen
 * first (the file's write order) locks in an incomplete snapshot instead. Records are
 * therefore merged per `message.id` by per-field max — input/cache fields are stable
 * across copies in practice, so this is a no-op for them, but it recovers the true
 * output count regardless of which copy the scan happens to see first.
 */
export class UsageAggregator {
  /** Every distinct message.id seen, including ones `since` later excludes — used only for requestCount. */
  private readonly seenMessageIds = new Set<string>();
  private readonly records = new Map<string, MessageRecord>();
  private readonly options: AggregatorOptions;

  constructor(options: AggregatorOptions = {}) {
    this.options = options;
  }

  addLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      return;
    }
    this.addRecord(record);
  }

  addRecord(record: unknown): void {
    if (typeof record !== 'object' || record === null) return;
    const entry = record as Record<string, unknown>;
    if (entry['type'] !== 'assistant') return;

    const message = entry['message'];
    if (typeof message !== 'object' || message === null) return;
    const messageFields = message as Record<string, unknown>;

    const usage = messageFields['usage'];
    if (typeof usage !== 'object' || usage === null) return;
    const usageFields = usage as Record<string, unknown>;

    const messageId = messageFields['id'];
    if (typeof messageId !== 'string' || messageId.length === 0) return;

    const model = typeof messageFields['model'] === 'string' ? messageFields['model'] : 'unknown';
    if (model === SYNTHETIC_MODEL) return;

    const timestamp = entry['timestamp'];
    if (typeof timestamp !== 'string') return;
    const instant = new Date(timestamp);
    if (Number.isNaN(instant.getTime())) return;

    // Counted as a distinct request only once the record is known to be well-formed usage,
    // so a malformed copy of an id can never suppress a later, valid copy of it.
    this.seenMessageIds.add(messageId);
    if (this.options.since && instant < this.options.since) return;

    const cacheCreationTokens = readCount(usageFields['cache_creation_input_tokens']);
    const rawCacheCreation = usageFields['cache_creation'];
    const cacheCreationFields =
      typeof rawCacheCreation === 'object' && rawCacheCreation !== null
        ? (rawCacheCreation as Record<string, unknown>)
        : null;
    // When the nested breakdown is absent (an older or truncated record), the whole cache-write
    // amount is attributed to the 5-minute tier — Anthropic's default TTL, and the tier most
    // cache writes actually use. This can undercount 1h-tier cost slightly, but it never
    // fabricates 1h-priced tokens that did not happen.
    const cacheCreation5mTokens = cacheCreationFields
      ? readCount(cacheCreationFields['ephemeral_5m_input_tokens'])
      : cacheCreationTokens;
    const cacheCreation1hTokens = cacheCreationFields ? readCount(cacheCreationFields['ephemeral_1h_input_tokens']) : 0;

    const counts: SplitTokenCounts = {
      inputTokens: readCount(usageFields['input_tokens']),
      outputTokens: readCount(usageFields['output_tokens']),
      cacheCreationTokens,
      cacheReadTokens: readCount(usageFields['cache_read_input_tokens']),
      cacheCreation5mTokens,
      cacheCreation1hTokens,
    };

    const fast = usageFields['speed'] === 'fast';
    const date = dateKey(instant, this.options.timeZone);
    const existing = this.records.get(messageId);
    this.records.set(
      messageId,
      existing
        ? { date, model, fast: existing.fast || fast, counts: maxSplitCounts(existing.counts, counts) }
        : { date, model, fast, counts },
    );
  }

  result(source: KnownSource): CollectResult {
    // Bucketed once here, after every copy of every message.id has been merged to its
    // final counts — bucketing incrementally per line would sum the same message's
    // partial snapshots into the day/model total instead of taking their max. The tier is
    // decided here too, from each message's final prompt length.
    const buckets = new Map<string, Aggregated>();
    for (const { date, model, fast, counts } of this.records.values()) {
      const pricingTier = tierForModel(model, counts, fast);
      const key = `${date}\0${model}\0${pricingTier}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.counts = addSplitCounts(existing.counts, counts);
      } else {
        buckets.set(key, {
          date,
          model,
          pricingTier,
          counts: addSplitCounts(emptySplitCounts(), counts),
        });
      }
    }

    const usage = [...buckets.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.model.localeCompare(b.model) ||
        PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
    );
    return { source, usage, requestCount: this.seenMessageIds.size };
  }
}
