import { COPILOT_CLI_SOURCE, dateKey, type CollectResult, type SplitTokenCounts } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { RequestBuckets, tierForModel } from '../request-buckets.js';
import type { UsageEventRow } from './sqlite.js';

export interface CopilotAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface CopilotDiagnostics {
  /** rows with a missing session id, a negative or non-integer count, or no readable timestamp. */
  malformedRows: number;
  /** rows whose cache reads plus writes exceeded the input; fresh input clamped to 0. */
  clampedRows: number;
}

/** A counter column: NULL counts as 0 (as the upstream parsers do); anything else must be a non-negative integer. */
function readCount(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * `created_at` is TEXT: SQLite's `YYYY-MM-DD HH:MM:SS` or ISO-8601 (with or without an offset), and
 * an offset-less time is UTC, as both upstream parsers read it. A number is epoch seconds or milliseconds.
 */
export function parseCreatedAt(value: unknown): Date | null {
  let instant: Date;
  // A numeric value stored in a TEXT column comes back as a digit string, so both spellings are epochs.
  const epoch = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null;
  if (epoch !== null) {
    if (!Number.isFinite(epoch) || epoch <= 0) return null;
    instant = new Date(epoch >= 1_000_000_000_000 ? epoch : epoch * 1000);
  } else if (typeof value === 'string') {
    const text = value.trim();
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
    if (!match) return null;
    instant = new Date(`${match[1]}T${match[2]}${match[3] ?? 'Z'}`);
  } else {
    return null;
  }
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Turns `assistant_usage_events` rows into requests. One row is one LLM request, keyed by session
 * id plus the row's autoincrement id. `input_tokens` includes cache reads and writes, so fresh
 * input is `input - cacheRead - cacheWrite` (clamped at 0). `output_tokens` is counted as recorded:
 * `reasoning_tokens` is never read, because whether it sits inside `output_tokens` is not confirmed
 * upstream and adding it could double count (see `docs/agents/copilot-cli-usage.md`).
 */
export class CopilotUsageAggregator {
  private readonly options: CopilotAggregatorOptions;
  private readonly buckets = new RequestBuckets();
  private malformedRows = 0;
  private clampedRows = 0;

  constructor(options: CopilotAggregatorOptions = {}) {
    this.options = options;
  }

  addRow(row: UsageEventRow): void {
    const sessionId = nonEmptyString(row.sessionId);
    const input = readCount(row.input);
    const output = readCount(row.output);
    const cacheRead = readCount(row.cacheRead);
    const cacheWrite = readCount(row.cacheWrite);
    const id = typeof row.id === 'number' && Number.isInteger(row.id) ? row.id : null;
    if (sessionId === null || id === null || input === null || output === null || cacheRead === null || cacheWrite === null) {
      this.malformedRows += 1;
      return;
    }
    // Rows with nothing to count exist (e.g. a failed request); they are not malformed.
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return;
    const instant = parseCreatedAt(row.createdAt);
    if (!instant) {
      this.malformedRows += 1;
      return;
    }
    if (this.options.since && instant < this.options.since) return;

    const fresh = input - cacheRead - cacheWrite;
    if (fresh < 0) this.clampedRows += 1;
    const counts: SplitTokenCounts = {
      inputTokens: Math.max(0, fresh),
      outputTokens: output,
      cacheCreationTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      // Copilot records one cache-write bucket; the 5m/1h split is unknown, never 0.
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    };
    // `copilot_usage_model` (newer stores) is the model the request was attributed to; `auto` is what the upstream parsers show when neither is set.
    const model = canonicalModelId(null, nonEmptyString(row.usageModel) ?? nonEmptyString(row.model) ?? 'auto');
    this.buckets.add(`${sessionId}\0${id}`, { date: dateKey(instant, this.options.timeZone), model, pricingTier: tierForModel(model, counts), counts });
  }

  diagnostics(): CopilotDiagnostics {
    return { malformedRows: this.malformedRows, clampedRows: this.clampedRows };
  }

  result(): CollectResult {
    return { source: COPILOT_CLI_SOURCE, usage: this.buckets.toUsage(), requestCount: this.buckets.size };
  }
}
