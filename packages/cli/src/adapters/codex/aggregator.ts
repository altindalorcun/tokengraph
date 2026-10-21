import {
  addSplitCounts,
  CODEX_CLI_SOURCE,
  dateKey,
  longContextThreshold,
  PRICING_TIERS,
  pricingTierFor,
  type CollectResult,
  type DailyModelUsage,
  type SplitTokenCounts,
} from '@tokengraph/core';

/** Used when a usage record cannot be tied to a turn's model — never a guess. */
export const UNKNOWN_MODEL = 'unknown';

/** `service_tier` values that bill at fast-mode rates ("priority" is fast mode's former name). */
const FAST_SERVICE_TIERS = new Set(['fast', 'priority']);

export interface CodexAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface CodexDiagnostics {
  /** Usage counted from token_count events, in files written before token_usage_record existed. */
  fallbackEvents: number;
  /** Usage events skipped because input or output was missing or not a number. */
  malformedEvents: number;
  /** Events whose input minus its cache sub-counts went negative and was clamped to 0. */
  clampedEvents: number;
}

interface RawUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

interface PendingEvent {
  instant: Date;
  usage: RawUsage;
  fast: boolean;
}

/** A response awaiting cross-file model resolution, keyed by response_id in resolvedRecords. */
interface ResolvedRecord {
  event: PendingEvent;
  model: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** input/output are required; the cache sub-counts are absent in some versions and mean none. */
function readUsage(value: unknown): RawUsage | null {
  const fields = asObject(value);
  if (!fields) return null;
  const input = readCount(fields['input_tokens']);
  const output = readCount(fields['output_tokens']);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cached: readCount(fields['cached_input_tokens']) ?? 0,
    cacheWrite: readCount(fields['cache_write_input_tokens']) ?? 0,
  };
}

/** `total_token_usage.total_tokens` — used only to recognise an unchanged fallback refresh. */
function readTotalTokens(value: unknown): number | null {
  const fields = asObject(value);
  if (!fields) return null;
  return readCount(fields['total_tokens']);
}

function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads Codex CLI rollout files. Each `token_usage_record` is one API response, identified by
 * `response_id` — deduplicated across files, because a forked or resumed session copies earlier
 * records into its new rollout. The model comes from the `turn_context` of the record's turn;
 * when the same response id appears in more than one file, a copy that resolves a real model
 * always wins over one that could only resolve to UNKNOWN_MODEL, since a fork can copy a record
 * before the turn_context that names its model. Among copies with the same resolution status
 * (both resolved, or both UNKNOWN_MODEL), the one with the earliest `instant` wins — ties keep
 * whichever copy was already stored — so the choice is independent of file read order. That
 * resolution can only be settled once every file has been read, so the affected response is not
 * added to a day's bucket until `result()` or `diagnostics()` is first called.
 *
 * Files from Codex versions without `token_usage_record` fall back to `token_count` events
 * (`last_token_usage` only — `total_token_usage` is cumulative and would count history again),
 * attributed to the most recent `turn_context` model. Those have no id, so they cannot be
 * deduplicated; the fallback is reported so a sync can say so. A file is deemed to use the new
 * format — and the fallback disabled for it — the moment any `token_usage_record` line appears
 * in it, even a malformed one, since a real Codex build never emits both.
 *
 * Codex's `input_tokens` includes cached and cache-write tokens, so both are subtracted to get
 * fresh input; reasoning tokens are already part of `output_tokens`.
 */
export class CodexUsageAggregator {
  private readonly options: CodexAggregatorOptions;
  private readonly resolvedRecords = new Map<string, ResolvedRecord>();
  private readonly buckets = new Map<string, DailyModelUsage>();
  private readonly counters: CodexDiagnostics = { fallbackEvents: 0, malformedEvents: 0, clampedEvents: 0 };
  private finalized = false;
  /** Resolved records actually kept by `since` — the only ones a request should be counted for. */
  private acceptedRecordCount = 0;

  // Per-file state, reset by beginFile().
  private turnModels = new Map<string, string>();
  private latestModel: string | null = null;
  private fast = false;
  private records: (PendingEvent & { turnId: string | null; responseId: string })[] = [];
  private tokenCounts: (PendingEvent & { model: string | null; totalTokens: number | null })[] = [];
  private sawRecord = false;

  constructor(options: CodexAggregatorOptions = {}) {
    this.options = options;
  }

  /** Once result() or diagnostics() has read the final buckets, more input would be silently lost. */
  private assertNotFinalized(): void {
    if (this.finalized) {
      throw new Error(
        'CodexUsageAggregator: beginFile/addLine/endFile cannot be called after result() or diagnostics() has finalized it.',
      );
    }
  }

  beginFile(): void {
    this.assertNotFinalized();
    this.turnModels = new Map();
    this.latestModel = null;
    this.fast = false;
    this.records = [];
    this.tokenCounts = [];
    this.sawRecord = false;
  }

  addLine(line: string): void {
    this.assertNotFinalized();
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

  private addRecord(record: unknown): void {
    const entry = asObject(record);
    const payload = asObject(entry?.['payload']);
    if (!entry || !payload) return;
    switch (entry['type']) {
      case 'turn_context':
        this.addTurnContext(payload);
        return;
      case 'token_usage_record':
        this.addUsageRecord(entry, payload);
        return;
      case 'event_msg':
        this.addEvent(entry, payload);
        return;
    }
  }

  private addTurnContext(payload: Record<string, unknown>): void {
    const model = nonEmptyString(payload['model']);
    if (!model) return;
    const turnId = nonEmptyString(payload['turn_id']);
    if (turnId) this.turnModels.set(turnId, model);
    this.latestModel = model;
  }

  private addUsageRecord(entry: Record<string, unknown>, payload: Record<string, unknown>): void {
    // Any token_usage_record line — even a malformed one below — marks this file as
    // new-format, so the token_count fallback never runs against it.
    this.sawRecord = true;
    const responseId = nonEmptyString(payload['response_id']);
    const instant = readInstant(entry['timestamp']);
    const usage = readUsage(payload['usage']);
    if (!responseId || !instant || !usage) {
      this.counters.malformedEvents += 1;
      return;
    }
    // Model resolution (and cross-file dedup) happens at endFile(), once this file's
    // turn_context lines have all been read.
    this.records.push({ instant, usage, fast: this.fast, turnId: nonEmptyString(payload['turn_id']), responseId });
  }

  private addEvent(entry: Record<string, unknown>, payload: Record<string, unknown>): void {
    if (payload['type'] === 'thread_settings_applied') {
      const tier = asObject(payload['thread_settings'])?.['service_tier'];
      if (typeof tier === 'string') this.fast = FAST_SERVICE_TIERS.has(tier);
      return;
    }
    if (payload['type'] !== 'token_count') return;
    const info = asObject(payload['info']);
    // A token_count with no info only carries rate-limit state, not usage.
    if (!info) return;
    const instant = readInstant(entry['timestamp']);
    const usage = readUsage(info['last_token_usage']);
    if (!instant || !usage) {
      this.counters.malformedEvents += 1;
      return;
    }
    const totalTokens = readTotalTokens(info['total_token_usage']);
    this.tokenCounts.push({ instant, usage, fast: this.fast, model: this.latestModel, totalTokens });
  }

  /**
   * Merges one file's copy of a response into the global map, deterministically (independent of
   * file read order): a copy that resolves a real model always beats one that could only resolve
   * to UNKNOWN_MODEL. Between two copies with the same resolution status (both resolved, or both
   * UNKNOWN_MODEL), the one with the earliest `instant` wins; on an equal instant, the copy
   * already stored is kept.
   */
  private mergeRecord(responseId: string, model: string, event: PendingEvent): void {
    const existing = this.resolvedRecords.get(responseId);
    if (!existing) {
      this.resolvedRecords.set(responseId, { event, model });
      return;
    }
    const resolved = model !== UNKNOWN_MODEL;
    const existingResolved = existing.model !== UNKNOWN_MODEL;
    if (resolved !== existingResolved) {
      if (resolved) this.resolvedRecords.set(responseId, { event, model });
      return;
    }
    if (event.instant < existing.event.instant) this.resolvedRecords.set(responseId, { event, model });
  }

  endFile(): void {
    this.assertNotFinalized();
    for (const record of this.records) {
      const model = (record.turnId && this.turnModels.get(record.turnId)) || UNKNOWN_MODEL;
      this.mergeRecord(record.responseId, model, { instant: record.instant, usage: record.usage, fast: record.fast });
    }
    if (!this.sawRecord) {
      // Older Codex builds can re-emit an unchanged token_count on a rate-limit refresh;
      // a run of identical total_token_usage totals is one event, not one per line. The last
      // total is tracked for every event with a known total — whether or not `since` kept it —
      // so a refresh of an event just before `since` is still recognised as a repeat once it
      // reappears just after `since`.
      let lastTotal: number | null = null;
      for (const event of this.tokenCounts) {
        const isRepeat = event.totalTokens !== null && event.totalTokens === lastTotal;
        if (event.totalTokens !== null) lastTotal = event.totalTokens;
        if (isRepeat) continue;
        const counted = this.add({ instant: event.instant, usage: event.usage, fast: event.fast }, event.model ?? UNKNOWN_MODEL);
        if (counted) this.counters.fallbackEvents += 1;
      }
    }
    this.beginFile();
  }

  /** Adds one resolved event to its day's bucket. Returns false when `since` drops it. */
  private add(event: PendingEvent, model: string): boolean {
    if (this.options.since && event.instant < this.options.since) return false;
    const { input, cached, cacheWrite, output } = event.usage;
    const fresh = input - cached - cacheWrite;
    if (fresh < 0) this.counters.clampedEvents += 1;
    const counts: SplitTokenCounts = {
      inputTokens: Math.max(0, fresh),
      outputTokens: output,
      cacheCreationTokens: cacheWrite,
      cacheReadTokens: cached,
      // OpenAI has no 5m/1h cache-write split: unknown, never 0.
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    };
    const pricingTier = pricingTierFor({ fast: event.fast, inputTokens: input, thresholdTokens: longContextThreshold(model) ?? undefined });
    const date = dateKey(event.instant, this.options.timeZone);
    const key = `${date}\0${model}\0${pricingTier}`;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.counts = addSplitCounts(existing.counts, counts);
    } else {
      // Seeded from the counts themselves: adding to emptySplitCounts() would turn null into 0.
      this.buckets.set(key, { date, model, pricingTier, counts });
    }
    return true;
  }

  /**
   * Buckets every cross-file-resolved response exactly once. Deferred until here — rather than
   * done in endFile() — because a later file's copy of a response can still replace an earlier
   * one's resolved model right up until the last file is read; guarded so a second call (result()
   * after diagnostics(), or either called twice) never double counts.
   */
  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    for (const { event, model } of this.resolvedRecords.values()) {
      if (this.add(event, model)) this.acceptedRecordCount += 1;
    }
  }

  diagnostics(): CodexDiagnostics {
    this.finalize();
    return { ...this.counters };
  }

  result(): CollectResult {
    this.finalize();
    const usage = [...this.buckets.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.model.localeCompare(b.model) ||
        PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
    );
    return {
      source: CODEX_CLI_SOURCE,
      usage,
      requestCount: this.acceptedRecordCount + this.counters.fallbackEvents,
    };
  }
}
