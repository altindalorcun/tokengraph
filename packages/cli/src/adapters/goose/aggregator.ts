import { GOOSE_SOURCE, dateKey, hourKey, type CollectResult, type SplitTokenCounts } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { RequestBuckets, tierForModel } from '../request-buckets.js';
import type { LedgerRow } from './sqlite.js';

/**
 * Goose providers that drive another coding agent, whose requests that agent's own logs already
 * record and another tokengraph adapter reads (`sessions.provider_name`, from `crates/goose/src/providers/*.rs`):
 * Claude Code (`claude-code`, `claude-acp`), Codex (`codex`, `codex-acp`), Gemini CLI, Cursor's CLI
 * (`cursor-agent`), Copilot CLI (`copilot-acp`) and pi (`pi-acp`). Not listed on purpose: `amp-acp`
 * (no adapter reads Amp's data), `github_copilot`, `chatgpt_codex` and `kimi_code` (direct HTTP calls
 * that no local agent log mirrors).
 */
export const EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set([
  'claude-code',
  'claude-acp',
  'codex',
  'codex-acp',
  'gemini-cli',
  'cursor-agent',
  'copilot-acp',
  'pi-acp',
]);

export interface GooseAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface GooseDiagnostics {
  /** rows with a negative or fractional count, or no readable timestamp. */
  malformedRows: number;
  /** synthetic rows `record_usage_metrics` adds for usage that predates the ledger. */
  carriedForwardRows: number;
  /** rows whose cache reads plus writes exceeded the input. */
  negativeInputRows: number;
  /** rows with neither a model nor a session model. */
  noModelRows: number;
}

/** A counter column: NULL counts as 0; anything else must be a non-negative integer. */
function readCount(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Goose treats a stored timestamp above this as milliseconds (`MILLISECOND_TIMESTAMP_THRESHOLD`); the ledger writes seconds. */
const MILLISECOND_THRESHOLD = 10_000_000_000;

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value > MILLISECOND_THRESHOLD ? value : value * 1000);
}

/**
 * A ledger row's identity. The row id alone is only unique within one database, so it is joined with
 * the session id and the row's timestamp: the same row read from two copies of one database (a backup,
 * a copied `GOOSE_PATH_ROOT`, a legacy folder) collapses, while two different databases would need the
 * same session id, the same row id and the same second to collide.
 */
function requestKey(row: LedgerRow, id: number): string {
  return `${String(row.sessionId ?? '')}\0${id}\0${String(row.createdTimestamp ?? '')}`;
}

/**
 * Turns `usage_ledger` rows into requests. One row is one provider call, keyed by its autoincrement
 * id. `input_tokens` includes cache reads and writes, so fresh input is `input - cacheRead -
 * cacheWrite`; a row where that is negative is skipped as unknown. Reasoning is not recorded and
 * is assumed to sit inside `output_tokens`. `carried_forward` rows and rows of wrapper providers
 * are skipped (see `docs/agents/goose-usage.md`).
 */
export class GooseUsageAggregator {
  private readonly options: GooseAggregatorOptions;
  private readonly buckets = new RequestBuckets();
  private malformedRows = 0;
  private carriedForwardRows = 0;
  private negativeInputRows = 0;
  private noModelRows = 0;

  constructor(options: GooseAggregatorOptions = {}) {
    this.options = options;
  }

  addRow(row: LedgerRow): void {
    if (row.costSource === 'carried_forward') {
      this.carriedForwardRows += 1;
      return;
    }
    const provider = nonEmptyString(row.provider);
    if (provider !== null && EXCLUDED_PROVIDERS.has(provider.toLowerCase())) return;

    const id = typeof row.id === 'number' && Number.isInteger(row.id) ? row.id : null;
    const input = readCount(row.input);
    const output = readCount(row.output);
    const cacheRead = readCount(row.cacheRead);
    const cacheWrite = readCount(row.cacheWrite);
    if (id === null || input === null || output === null || cacheRead === null || cacheWrite === null) {
      this.malformedRows += 1;
      return;
    }
    // Rows with nothing to count exist (e.g. a failed call); they are not malformed.
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return;
    const instant = parseTimestamp(row.createdTimestamp);
    if (!instant) {
      this.malformedRows += 1;
      return;
    }
    if (this.options.since && instant < this.options.since) return;

    const fresh = input - cacheRead - cacheWrite;
    if (fresh < 0) {
      this.negativeInputRows += 1;
      return;
    }
    const rawModel = nonEmptyString(row.model) ?? nonEmptyString(row.sessionModel);
    if (rawModel === null) {
      this.noModelRows += 1;
      return;
    }
    const counts: SplitTokenCounts = {
      inputTokens: fresh,
      outputTokens: output,
      cacheCreationTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      // Goose records one cache-write count; the 5m/1h split is unknown, never 0.
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    };
    const model = canonicalModelId(null, rawModel);
    this.buckets.add(requestKey(row, id), { date: dateKey(instant, this.options.timeZone), hour: hourKey(instant, this.options.timeZone), model, pricingTier: tierForModel(model, counts), counts });
  }

  diagnostics(): GooseDiagnostics {
    return {
      malformedRows: this.malformedRows,
      carriedForwardRows: this.carriedForwardRows,
      negativeInputRows: this.negativeInputRows,
      noModelRows: this.noModelRows,
    };
  }

  result(): CollectResult {
    return { source: GOOSE_SOURCE, usage: this.buckets.toUsage(), hours: this.buckets.toHours(), requestCount: this.buckets.size };
  }
}
