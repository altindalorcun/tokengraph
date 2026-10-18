import { dateKey, QWEN_CODE_SOURCE, type CollectResult, type SplitTokenCounts } from '@tokengraph/core';
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
 * output. Side calls outside the chat loop are not recorded, so totals are a lower bound.
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

    const fresh = prompt - cached;
    this.diagnosis.noteValid(id, fresh < 0 ? ['clamped'] : []);

    const counts: SplitTokenCounts = {
      inputTokens: Math.max(0, fresh),
      // total - prompt covers thoughts that sit outside candidates (Gemini API); on the other
      // protocols it equals candidates, so thoughts are never added on top.
      outputTokens: Math.max(candidates, total - prompt),
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    };
    const model = canonicalModelId(null, nonEmptyString(entry['model']) ?? fallbackModel);
    const request: RequestRecord = { date: dateKey(instant, this.options.timeZone), model, pricingTier: tierForModel(model, counts), counts };
    this.buckets.add(id, request);
  }

  diagnostics(): QwenDiagnostics {
    return {
      malformedRecords: this.diagnosis.malformedCount + this.unkeyedMalformed,
      clampedRecords: this.diagnosis.count('clamped'),
      unreadableFiles: this.unreadableFiles,
    };
  }

  result(): CollectResult {
    return { source: QWEN_CODE_SOURCE, usage: this.buckets.toUsage(), requestCount: this.buckets.size };
  }
}
