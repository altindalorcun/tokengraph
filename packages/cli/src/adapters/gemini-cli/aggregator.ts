import { dateKey, GEMINI_CLI_SOURCE, type CollectResult, type SplitTokenCounts } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { RequestBuckets, tierForModel, type RequestRecord } from '../request-buckets.js';

export interface GeminiAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface GeminiDiagnostics {
  /** gemini messages with a tokens object lacking a numeric input or output. */
  malformedMessages: number;
  /** messages whose cached count exceeded input; fresh input clamped to 0. */
  clampedMessages: number;
  /** messages whose total did not equal input + output + thoughts + tool (counted anyway). */
  totalMismatches: number;
  /** files that could not be parsed at all. */
  unreadableFiles: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** input/output are required and must be finite, non-negative integers; anything else is malformed. */
function readRequiredCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * cached/thoughts/tool default to 0 when the field is absent — that's not malformed, just an older
 * or leaner record. A *present* value must be a finite, non-negative integer; a present negative or
 * non-integer value is malformed (returns null) rather than being silently coerced to 0.
 */
function readOptionalCount(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Reads Gemini CLI chat recordings. One `type: "gemini"` message with a `tokens` object is one
 * API request; its `id` is global across files, since the same id can reappear in a hash→slug
 * directory copy, the legacy `.json`→`.jsonl` migration, and `$set.messages` checkpoints — all of
 * them are collected as candidates and deduplicated by id (a token-bearing copy wins over one
 * without, via {@link RequestBuckets}'s per-field max-merge). `$rewindTo` lines are ignored: the
 * requests they rewind past were still billed, Gemini CLI only drops them from visible history.
 * Side calls the CLI makes outside the chat loop (web search, context compression, model routing,
 * retried invalid streams) are never written to these files, so the totals here are a lower bound
 * on actual usage, never an overcount.
 */
export class GeminiUsageAggregator {
  private readonly options: GeminiAggregatorOptions;
  private readonly buckets = new RequestBuckets();
  /**
   * Per-id diagnosis state, resolved the same way OpenCode resolves its request keys: a diagnostic
   * is tentative until every copy of an id has been seen, and is only kept if no copy of that id
   * ever cleared it. `resolvedIds` — a valid (non-malformed) copy has been seen, so `malformed` can
   * never be (re-)recorded for this id. `cleanIds` — a fully clean valid copy (no clamp, no
   * mismatch) has been seen, so `clamped`/`mismatch` can never be (re-)recorded for this id either.
   */
  private readonly resolvedIds = new Set<string>();
  private readonly cleanIds = new Set<string>();
  private readonly pendingMalformed = new Set<string>();
  private readonly pendingClamped = new Set<string>();
  private readonly pendingMismatch = new Set<string>();
  private unreadableFiles = 0;

  constructor(options: GeminiAggregatorOptions = {}) {
    this.options = options;
  }

  /** One parsed JSONL line (any kind: metadata, message, $set, $rewindTo). */
  addRecord(record: unknown): void {
    const entry = asObject(record);
    if (!entry) return;
    if ('$rewindTo' in entry) return;
    this.addCandidate(entry);
    const messages = asObject(entry['$set'])?.['messages'];
    if (Array.isArray(messages)) for (const message of messages) this.addCandidate(message);
  }

  /** A whole legacy `.json` session document ({ messages: [...] }). */
  addDocument(document: unknown): void {
    const messages = asObject(document)?.['messages'];
    if (!Array.isArray(messages)) return;
    for (const message of messages) this.addCandidate(message);
  }

  noteUnreadableFile(): void {
    this.unreadableFiles += 1;
  }

  private addCandidate(value: unknown): void {
    const message = asObject(value);
    if (!message || message['type'] !== 'gemini') return;
    const id = nonEmptyString(message['id']);
    const tokens = asObject(message['tokens']);
    if (!id || !tokens) return;
    const instant = readInstant(message['timestamp']);
    if (!instant) return;
    if (this.options.since && instant < this.options.since) return;

    const input = readRequiredCount(tokens['input']);
    const output = readRequiredCount(tokens['output']);
    const cached = readOptionalCount(tokens['cached']);
    const thoughts = readOptionalCount(tokens['thoughts']);
    const tool = readOptionalCount(tokens['tool']);
    if (input === null || output === null || cached === null || thoughts === null || tool === null) {
      if (!this.resolvedIds.has(id)) this.pendingMalformed.add(id);
      return;
    }
    this.resolvedIds.add(id);
    this.pendingMalformed.delete(id);

    const fresh = input - cached;
    const isClamped = fresh < 0;
    if (isClamped && !this.cleanIds.has(id)) this.pendingClamped.add(id);

    const total = tokens['total'];
    const isMismatch = typeof total === 'number' && total !== input + output + thoughts + tool;
    if (isMismatch && !this.cleanIds.has(id)) this.pendingMismatch.add(id);

    if (!isClamped && !isMismatch) {
      this.cleanIds.add(id);
      this.pendingClamped.delete(id);
      this.pendingMismatch.delete(id);
    }

    const counts: SplitTokenCounts = {
      inputTokens: Math.max(0, fresh) + tool,
      outputTokens: output + thoughts,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    };
    const model = canonicalModelId(null, typeof message['model'] === 'string' ? message['model'] : null);
    const record: RequestRecord = { date: dateKey(instant, this.options.timeZone), model, pricingTier: tierForModel(model, counts), counts };
    this.buckets.add(id, record);
  }

  diagnostics(): GeminiDiagnostics {
    return {
      malformedMessages: this.pendingMalformed.size,
      clampedMessages: this.pendingClamped.size,
      totalMismatches: this.pendingMismatch.size,
      unreadableFiles: this.unreadableFiles,
    };
  }

  result(): CollectResult {
    return { source: GEMINI_CLI_SOURCE, usage: this.buckets.toUsage(), requestCount: this.buckets.size };
  }
}
