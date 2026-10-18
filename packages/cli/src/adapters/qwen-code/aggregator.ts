import { dateKey, PRICING_TIERS, QWEN_CODE_SOURCE, weightedTokens, type CollectResult, type DailyModelUsage, type SplitTokenCounts } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { CopyDiagnostics } from '../record-diagnostics.js';
import { RequestBuckets, tierForModel, type RequestRecord } from '../request-buckets.js';
import { asObject, nonEmptyString, readInstant, readOptionalCount, readRequiredCount } from '../usage-fields.js';

export interface QwenAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface QwenDiagnostics {
  /** assistant records with usage whose uuid, timestamp or token counts are missing or invalid. */
  malformedRecords: number;
  /** records whose cached count exceeded the prompt; fresh input clamped to 0. */
  clampedRecords: number;
  /** files that could not be read at all. */
  unreadableFiles: number;
  /** usage ledger records whose `schemaVersion` is not the one this reader knows. */
  unknownSchemaRecords: number;
}

/** One source's result with its request count per date, so two sources can be compared day by day. */
export interface QwenSourceResult {
  usage: DailyModelUsage[];
  requestsByDate: Map<string, number>;
}

/** The counters shared by both sources: prompt (cache included), cached, output and total. */
function normalisedCounts(prompt: number, cached: number, output: number, total: number): SplitTokenCounts {
  return {
    inputTokens: Math.max(0, prompt - cached),
    // total - prompt covers thoughts that sit outside candidates (Gemini API); on the other
    // protocols it equals candidates, so thoughts are never added on top.
    outputTokens: Math.max(output, total - prompt),
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
  };
}

/**
 * Every top-level JSON object on a line. Qwen Code has written two records glued together as
 * `}{` (QwenLM/qwen-code#3606), so a line that does not parse whole is scanned for balanced
 * objects instead of being dropped. Braces inside strings do not count; an incomplete trailing
 * object (a partial write) is dropped.
 */
export function parseJsonObjects(line: string): unknown[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const whole: unknown = JSON.parse(trimmed);
    return asObject(whole) && !Array.isArray(whole) ? [whole] : [];
  } catch {
    // Fall through to the scan below.
  }
  const objects: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      if (depth > 0) inString = true;
    } else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          objects.push(JSON.parse(trimmed.slice(start, i + 1)));
        } catch {
          // A balanced but invalid fragment is skipped.
        }
      }
    }
  }
  return objects;
}

/**
 * Reads Qwen Code chat records. One `type: "assistant"` record with a `usageMetadata` object is
 * one API request; its `uuid` is global across files, since `/branch` copies every retained
 * record, usage included, into the new session's file. Only the usage counters, `model`, `uuid`
 * and `timestamp` are read; message text is never touched. `usageMetadata` is Gemini-shaped but
 * its meaning depends on the wire protocol, which the record does not name: `promptTokenCount`
 * includes cached tokens (and, on the Anthropic protocol, cache-creation tokens, which are not
 * stored separately and so count as fresh input here), and `thoughtsTokenCount` is never added to
 * output. Calls outside the chat loop (the managed memory extractor's) are not recorded here; the
 * usage ledger has them (`QwenLedgerAggregator`).
 */
export class QwenUsageAggregator {
  private readonly options: QwenAggregatorOptions;
  private readonly buckets = new RequestBuckets();
  private readonly diagnosis = new CopyDiagnostics<'clamped'>();
  /** Malformed records that have no uuid to match copies by. */
  private unkeyedMalformed = 0;
  private unreadableFiles = 0;

  constructor(options: QwenAggregatorOptions = {}) {
    this.options = options;
  }

  noteUnreadableFile(): void {
    this.unreadableFiles += 1;
  }

  /** One parsed JSONL record; `fallbackModel` names the model for a record that carries none (subagents). */
  addRecord(record: unknown, fallbackModel: string | null = null): void {
    const entry = asObject(record);
    if (!entry || entry['type'] !== 'assistant') return;
    // An assistant record without usage (text streamed before the usage chunk) is not a request.
    const usage = asObject(entry['usageMetadata']);
    if (!usage) return;
    const instant = readInstant(entry['timestamp']);
    if (instant && this.options.since && instant < this.options.since) return;

    const id = nonEmptyString(entry['uuid']);
    const prompt = readRequiredCount(usage['promptTokenCount']);
    const candidates = readOptionalCount(usage['candidatesTokenCount']);
    const cached = readOptionalCount(usage['cachedContentTokenCount']);
    const total = readOptionalCount(usage['totalTokenCount']);
    if (!id || !instant || prompt === null || candidates === null || cached === null || total === null) {
      if (id) this.diagnosis.noteMalformed(id);
      else this.unkeyedMalformed += 1;
      return;
    }

    this.diagnosis.noteValid(id, prompt < cached ? ['clamped'] : []);

    const counts = normalisedCounts(prompt, cached, candidates, total);
    const model = canonicalModelId(null, nonEmptyString(entry['model']) ?? fallbackModel);
    const request: RequestRecord = { date: dateKey(instant, this.options.timeZone), model, pricingTier: tierForModel(model, counts), counts };
    this.buckets.add(id, request);
  }

  diagnostics(): QwenDiagnostics {
    return {
      malformedRecords: this.diagnosis.malformedCount + this.unkeyedMalformed,
      clampedRecords: this.diagnosis.count('clamped'),
      unreadableFiles: this.unreadableFiles,
      unknownSchemaRecords: 0,
    };
  }

  result(): QwenSourceResult {
    return { usage: this.buckets.toUsage(), requestsByDate: this.buckets.requestsByDate() };
  }
}

/** The only `schemaVersion` of Qwen Code's usage ledger this reader understands. */
const LEDGER_SCHEMA_VERSION = 1;

/**
 * Reads Qwen Code's own per-request ledger, `usage/token-usage-YYYY-MM.jsonl` (Qwen Code 0.19.0 and
 * later, while `privacy.usageStatisticsEnabled` is on). Unlike the chat records it also holds the
 * managed memory extractor's requests. A record's `id` is its request; only `schemaVersion`, `id`,
 * `timestamp`, `model` and the token counters are read, never the session id. `inputTokens`
 * includes cached tokens (and, on the Anthropic protocol, cache creation), exactly as
 * `promptTokenCount` does, so the arithmetic is the chat records'. `thoughtsTokens` is never added.
 */
export class QwenLedgerAggregator {
  private readonly options: QwenAggregatorOptions;
  private readonly buckets = new RequestBuckets();
  private readonly diagnosis = new CopyDiagnostics<'clamped'>();
  /** Malformed records that have no id to match copies by. */
  private unkeyedMalformed = 0;
  private unknownSchemaRecords = 0;
  private unreadableFiles = 0;

  constructor(options: QwenAggregatorOptions = {}) {
    this.options = options;
  }

  noteUnreadableFile(): void {
    this.unreadableFiles += 1;
  }

  addRecord(record: unknown): void {
    const entry = asObject(record);
    if (!entry) return;
    const instant = readInstant(entry['timestamp']);
    if (instant && this.options.since && instant < this.options.since) return;
    // An unknown schema may have changed what the counters mean, and an overcount cannot be undone.
    if (entry['schemaVersion'] !== LEDGER_SCHEMA_VERSION) {
      this.unknownSchemaRecords += 1;
      return;
    }

    const id = nonEmptyString(entry['id']);
    const input = readRequiredCount(entry['inputTokens']);
    const output = readRequiredCount(entry['outputTokens']);
    const cached = readOptionalCount(entry['cachedTokens']);
    const total = readOptionalCount(entry['totalTokens']);
    if (!id || !instant || input === null || output === null || cached === null || total === null) {
      if (id) this.diagnosis.noteMalformed(id);
      else this.unkeyedMalformed += 1;
      return;
    }

    this.diagnosis.noteValid(id, input < cached ? ['clamped'] : []);

    const counts = normalisedCounts(input, cached, output, total);
    const model = canonicalModelId(null, nonEmptyString(entry['model']));
    this.buckets.add(id, { date: dateKey(instant, this.options.timeZone), model, pricingTier: tierForModel(model, counts), counts });
  }

  diagnostics(): QwenDiagnostics {
    return {
      malformedRecords: this.diagnosis.malformedCount + this.unkeyedMalformed,
      clampedRecords: this.diagnosis.count('clamped'),
      unreadableFiles: this.unreadableFiles,
      unknownSchemaRecords: this.unknownSchemaRecords,
    };
  }

  result(): QwenSourceResult {
    return { usage: this.buckets.toUsage(), requestsByDate: this.buckets.requestsByDate() };
  }
}

/**
 * For each date, all of the rows from the source whose weighted-token total for that day is larger
 * (the ledger on a tie); the two are never summed or mixed within a day. Both sources are subsets
 * of the requests that really happened (chats miss the memory extractor, the ledger misses days
 * before Qwen Code 0.19.0 or with usage statistics off), so the per-day maximum cannot overcount.
 * The only undercount is a day where some requests are in one source only and others in the
 * other. A per-session choice was rejected: `/branch` copies records into a new session id, which
 * would count the same requests in two sessions.
 */
export function combineQwenSources(chats: QwenSourceResult, ledger: QwenSourceResult): CollectResult {
  const weightByDate = (usage: DailyModelUsage[]): Map<string, number> => {
    const weights = new Map<string, number>();
    for (const row of usage) weights.set(row.date, (weights.get(row.date) ?? 0) + weightedTokens(row.counts));
    return weights;
  };
  const chatWeights = weightByDate(chats.usage);
  const ledgerWeights = weightByDate(ledger.usage);
  const ledgerWins = (date: string): boolean => (ledgerWeights.get(date) ?? 0) >= (chatWeights.get(date) ?? 0);

  let requestCount = 0;
  for (const date of new Set([...chatWeights.keys(), ...ledgerWeights.keys()])) {
    requestCount += (ledgerWins(date) ? ledger : chats).requestsByDate.get(date) ?? 0;
  }
  const usage = [...chats.usage.filter((row) => !ledgerWins(row.date)), ...ledger.usage.filter((row) => ledgerWins(row.date))];
  usage.sort(
    (a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model) || PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
  );
  return { source: QWEN_CODE_SOURCE, usage, requestCount };
}
