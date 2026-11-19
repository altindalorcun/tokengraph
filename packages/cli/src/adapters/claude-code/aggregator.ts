import {
  addSplitCounts,
  CLAUDE_CODE_SOURCE,
  CLAUDE_WINDOW_MINUTES,
  dateKey,
  emptySplitCounts,
  HourSums,
  hourKey,
  maxSplitCounts,
  PRICING_TIERS,
  weightedTokens,
  type CollectResult,
  type KnownSource,
  type LimitReading,
  type PricingTier,
  type SplitTokenCounts,
} from '@tokengraph/core';
import { groupByFolder, tierForModel, type FolderRequest } from '../request-buckets.js';

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
  hour: number;
  model: string;
  /** usage.speed was "fast" on a copy of this message. */
  fast: boolean;
  counts: SplitTokenCounts;
  /** The record's `cwd`: where the session ran. The first copy that has one wins. */
  folder: string | null;
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
  private readonly records = new Map<string, MessageRecord>();
  /** The newest refused request per limit window (`apiErrorParams.rate_limit_info`), as a full-window reading. */
  private readonly limitHits = new Map<string, LimitReading>();
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
    this.addLimitHit(entry);

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
    const hour = hourKey(instant, this.options.timeZone);
    const folder = typeof entry['cwd'] === 'string' && entry['cwd'] !== '' ? entry['cwd'] : null;
    const existing = this.records.get(messageId);
    this.records.set(
      messageId,
      existing
        ? { date, hour, model, fast: existing.fast || fast, counts: maxSplitCounts(existing.counts, counts), folder: existing.folder ?? folder }
        : { date, hour, model, fast, counts, folder },
    );
  }

  /**
   * A request Claude Code was refused for a plan limit: that window is full until it resets. Written as a
   * `<synthetic>` message, so it never counts as usage; only refusals the scan window reaches are kept.
   */
  private addLimitHit(entry: Record<string, unknown>): void {
    const params = entry['apiErrorParams'];
    if (typeof params !== 'object' || params === null) return;
    const info = (params as Record<string, unknown>)['rate_limit_info'];
    if (typeof info !== 'object' || info === null) return;
    const { status, rateLimitType, resetsAt } = info as Record<string, unknown>;
    if (status !== 'rejected' || typeof rateLimitType !== 'string' || rateLimitType === '') return;
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return;
    const timestamp = entry['timestamp'];
    if (typeof timestamp !== 'string') return;
    const instant = new Date(timestamp);
    if (Number.isNaN(instant.getTime())) return;
    if (this.options.since && instant < this.options.since) return;
    const held = this.limitHits.get(rateLimitType);
    if (held && Date.parse(held.readAt) >= instant.getTime()) return;
    this.limitHits.set(rateLimitType, {
      source: CLAUDE_CODE_SOURCE,
      limitId: null,
      plan: null,
      origin: 'limit-hit',
      readAt: timestamp,
      credits: null,
      windows: [{ id: rateLimitType, minutes: CLAUDE_WINDOW_MINUTES[rateLimitType] ?? null, usedPercent: 100, resetsAt: new Date(resetsAt * 1000).toISOString() }],
    });
  }

  result(source: KnownSource): CollectResult {
    // Bucketed once here, after every copy of every message.id has been merged to its
    // final counts — bucketing incrementally per line would sum the same message's
    // partial snapshots into the day/model total instead of taking their max. The tier is
    // decided here too, from each message's final prompt length.
    const buckets = new Map<string, Aggregated>();
    const hours = new HourSums();
    const requests: FolderRequest[] = [];
    for (const { date, hour, model, fast, counts, folder } of this.records.values()) {
      hours.add(date, hour, weightedTokens(counts));
      const pricingTier = tierForModel(model, counts, fast);
      requests.push({ date, model, pricingTier, counts, folder });
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
    const limits = [...this.limitHits.values()].sort((a, b) => a.windows[0]!.id.localeCompare(b.windows[0]!.id));
    return {
      source,
      usage,
      hours: hours.toList(),
      projects: groupByFolder(requests),
      requestCount: this.records.size, // distinct requests in the window, like every other adapter
      ...(limits.length > 0 ? { limits } : {}),
    };
  }
}
