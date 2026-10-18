import { dateKey, PI_SOURCE, type CollectResult, type SplitTokenCounts } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { RequestBuckets, tierForModel } from '../request-buckets.js';

export interface PiAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface PiDiagnostics {
  /** `message` / `usage` entries whose usage, model or time could not be read. */
  malformedRecords: number;
  /** compaction, branch summary and tool result usage: real tokens, but no model to book them under. */
  unattributedRecords: number;
}

/** pi's `Usage` counters are whole tokens; anything else is not trusted. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** pi reports `cacheWrite1h` only through these two request APIs (ai/src/api/anthropic-messages.ts, bedrock-converse-stream.ts). */
const CACHE_SPLIT_APIS = new Set(['anthropic-messages', 'bedrock-converse-stream']);
const CACHE_SPLIT_PROVIDERS = new Set(['anthropic', 'amazon-bedrock']);

interface ReadUsage {
  counts: SplitTokenCounts;
  /** Every counter is 0: a request that failed before the provider reported anything. */
  empty: boolean;
}

/**
 * pi's `Usage`: `input` is already exclusive of cache and `reasoning` is a subset of `output`, so
 * the four counters map straight across and `reasoning` is never read. `cacheWrite1h` is a subset of
 * `cacheWrite`; it is trusted only where the API that produced the request fills it in. A missing
 * `cacheRead`/`cacheWrite` (very old files) is 0.
 */
function readUsage(raw: unknown, trustsCacheSplit: boolean): ReadUsage | null {
  const usage = asObject(raw);
  if (!usage) return null;
  const cacheRead = usage['cacheRead'] ?? 0;
  const cacheWrite = usage['cacheWrite'] ?? 0;
  const { input, output } = usage;
  if (!isCount(input) || !isCount(output) || !isCount(cacheRead) || !isCount(cacheWrite)) return null;
  const cacheWrite1h = usage['cacheWrite1h'];
  const known = trustsCacheSplit && isCount(cacheWrite1h);
  const longTier = known ? Math.min(cacheWrite1h, cacheWrite) : null;
  return {
    counts: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      cacheCreation5mTokens: longTier === null ? null : cacheWrite - longTier,
      cacheCreation1hTokens: longTier,
    },
    empty: input + output + cacheRead + cacheWrite === 0,
  };
}

/** Whether a usage object carries tokens, for the "no model" note; an unreadable one counts as none. */
function hasTokens(raw: unknown): boolean {
  const usage = readUsage(raw, false);
  return usage !== null && !usage.empty;
}

/**
 * Turns pi session entries into requests. Two entry kinds name a model and carry usage: an
 * assistant `message` (one API response) and a `usage` entry (cache warming and other
 * model-attributed calls; any `kind` counts). A request is keyed by `(provider, responseId)`, or by
 * its start time, model and counters when the provider gave no id: forking a session writes a new
 * file holding copies of the same entries, and a copy merges into the original. All branches of a
 * session tree are counted, since abandoned branches were billed too.
 */
export class PiUsageAggregator {
  private readonly options: PiAggregatorOptions;
  private readonly buckets = new RequestBuckets();
  private readonly unattributed = new Set<string>();
  private malformedRecords = 0;

  constructor(options: PiAggregatorOptions = {}) {
    this.options = options;
  }

  addLine(line: string): void {
    // Only lines that can hold usage are parsed; session text is never inspected.
    if (!line.includes('"usage"')) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    this.addRecord(record);
  }

  addRecord(record: unknown): void {
    const entry = asObject(record);
    if (!entry) return;
    const type = entry['type'];
    if (type === 'message') {
      const message = asObject(entry['message']);
      if (!message) return;
      if (message['role'] === 'assistant') this.addRequest(entry, message, 'message');
      else if (message['role'] === 'toolResult') this.noteUnattributed(entry, message['usage']);
    } else if (type === 'usage') {
      this.addRequest(entry, entry, 'usage');
    } else if (type === 'compaction' || type === 'branch_summary') {
      this.noteUnattributed(entry, entry['usage']);
    }
  }

  private noteUnattributed(entry: Record<string, unknown>, usage: unknown): void {
    if (!hasTokens(usage)) return;
    // Forked files copy these entries; their id and time identify the copy.
    this.unattributed.add(`${String(entry['type'])}\0${String(entry['id'])}\0${String(entry['timestamp'])}`);
  }

  private addRequest(entry: Record<string, unknown>, holder: Record<string, unknown>, kind: 'message' | 'usage'): void {
    const provider = nonEmptyString(holder['provider']);
    const api = nonEmptyString(holder['api']);
    const trustsCacheSplit = (api !== null && CACHE_SPLIT_APIS.has(api)) || (provider !== null && CACHE_SPLIT_PROVIDERS.has(provider));
    const read = readUsage(holder['usage'], trustsCacheSplit);

    // A message's own request time is unix ms; a usage entry has only the entry's ISO time.
    const messageTime = kind === 'message' && typeof holder['timestamp'] === 'number' ? holder['timestamp'] : null;
    const entryTime = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
    const instant = new Date(messageTime ?? entryTime);
    const rawModel = (kind === 'message' ? nonEmptyString(holder['responseModel']) : null) ?? nonEmptyString(holder['model']);

    if (!read || rawModel === null || Number.isNaN(instant.getTime())) {
      this.malformedRecords += 1;
      return;
    }
    if (read.empty) return;
    if (this.options.since && instant < this.options.since) return;

    const model = canonicalModelId(provider, rawModel);
    const { counts } = read;
    const responseId = kind === 'message' ? nonEmptyString(holder['responseId']) : null;
    const key = responseId
      ? `id\0${provider ?? ''}\0${responseId}`
      : [kind, instant.getTime(), provider ?? '', rawModel, counts.inputTokens, counts.outputTokens, counts.cacheReadTokens, counts.cacheCreationTokens].join('\0');
    this.buckets.add(key, { date: dateKey(instant, this.options.timeZone), model, pricingTier: tierForModel(model, counts), counts });
  }

  diagnostics(): PiDiagnostics {
    return { malformedRecords: this.malformedRecords, unattributedRecords: this.unattributed.size };
  }

  result(): CollectResult {
    return { source: PI_SOURCE, usage: this.buckets.toUsage(), requestCount: this.buckets.size };
  }
}
