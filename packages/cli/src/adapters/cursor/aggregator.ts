import {
  addSplitCounts,
  CURSOR_SOURCE,
  dateKey,
  DEFAULT_PRICING_TIER,
  maxSplitCounts,
  PRICING_TIERS,
  type CollectResult,
  type DailyModelUsage,
  type PricingTier,
  type SplitTokenCounts,
} from '@tokengraph/core';
import { capModelName, normalizeClaudeModel } from '../model-ids.js';
import type { CursorEvent } from './events.js';
import type { ImportedRow } from './imports.js';

export { MAX_MODEL_NAME_LENGTH } from '../model-ids.js';
/** Cursor's name for {@link normalizeClaudeModel}, kept for existing callers. */
export const normalizeCursorModel = normalizeClaudeModel;

export interface CursorAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface CursorDiagnostics {
  /** Turns whose hook payload carried no input or output count (undocumented fields, older Cursor). */
  missingCounts: number;
  /** Turns whose input minus its cache sub-counts went negative and was clamped to 0. */
  clampedEvents: number;
}

interface TurnRecord {
  date: string;
  model: string;
  pricingTier: PricingTier;
  counts: SplitTokenCounts;
}

const FAST_SUFFIX = '-fast';

/**
 * True when the raw slug embeds a literal `fast` word between hyphens (e.g.
 * `claude-4.5-opus-high-thinking-fast`), case-insensitively. `normalizeCursorModel` drops
 * unrecognised words — including a `fast` one — while rebuilding a Claude id, so this signal has
 * to be read off the raw slug before normalising, not off the normalised result.
 */
function hasFastWord(raw: string): boolean {
  return raw.trim().toLowerCase().split('-').includes('fast');
}

/**
 * Composer's Fast variant has its own published rates, so it is its own model. Fast mode on any
 * other model is the same model at a faster (pricier) tier: it stays under that model's name, so
 * its tokens still merge with the model's other usage, and is priced by the fast tier (unknown
 * where no fast rate is recorded).
 */
export function cursorModelIdentity(event: Pick<CursorEvent, 'model' | 'modelId' | 'fast'>): { model: string; pricingTier: PricingTier } {
  const raw = event.modelId ?? event.model ?? 'unknown';
  const base = normalizeClaudeModel(raw);
  const fast = event.fast || hasFastWord(raw);
  if (!fast) return { model: capModelName(base), pricingTier: DEFAULT_PRICING_TIER };
  // Cursor sends this lowercase today; matched case-insensitively so a future capitalised id
  // still lands on Composer's own rates instead of silently falling through to the fast tier.
  if (base.toLowerCase().startsWith('composer-')) {
    return { model: capModelName(base.toLowerCase(), FAST_SUFFIX), pricingTier: DEFAULT_PRICING_TIER };
  }
  return { model: capModelName(base), pricingTier: 'fast' };
}

/**
 * Aggregates Cursor `stop` hook events. A turn's counts are cumulative for that turn and
 * identical across repeated deliveries of the same `generation_id`, so turns are deduplicated
 * by id with a per-field max. Cursor's `input_tokens` includes cache reads and writes, which
 * are subtracted to get fresh input. Only the parent agent's turn is reported by Cursor —
 * subagent usage is not available locally. Fast mode on Composer is its own model (its own
 * published rates); fast mode on any other model keeps that model's name and is priced at the
 * `fast` tier instead. Cursor's Claude slugs are normalised to Anthropic's canonical model id
 * (see {@link normalizeClaudeModel}) so a model's Cursor usage merges with its usage elsewhere.
 */
export class CursorUsageAggregator {
  private readonly options: CursorAggregatorOptions;
  private readonly turns = new Map<string, TurnRecord>();
  private readonly counters: CursorDiagnostics = { missingCounts: 0, clampedEvents: 0 };
  private hookStart: Date | null = null;

  constructor(options: CursorAggregatorOptions = {}) {
    this.options = options;
  }

  add(event: CursorEvent): void {
    const instant = new Date(event.receivedAt);
    if (Number.isNaN(instant.getTime())) return;
    // Before the since filter: the cutoff for imported rows is the hook's first turn ever, not the first in the window.
    if (!this.hookStart || instant < this.hookStart) this.hookStart = instant;
    if (this.options.since && instant < this.options.since) return;
    if (event.inputTokens === null || event.outputTokens === null) {
      this.counters.missingCounts += 1;
      return;
    }
    const cacheRead = event.cacheReadTokens ?? 0;
    const cacheWrite = event.cacheWriteTokens ?? 0;
    const fresh = event.inputTokens - cacheRead - cacheWrite;
    if (fresh < 0) this.counters.clampedEvents += 1;
    const counts: SplitTokenCounts = {
      inputTokens: Math.max(0, fresh),
      outputTokens: event.outputTokens,
      cacheCreationTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      // Cursor reports no 5m/1h cache-write split: unknown, never 0.
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    };
    const date = dateKey(instant, this.options.timeZone);
    const { model, pricingTier } = cursorModelIdentity(event);
    const existing = this.turns.get(event.generationId);
    this.turns.set(
      event.generationId,
      existing
        ? { date: existing.date, model, pricingTier, counts: maxSplitCounts(existing.counts, counts) }
        : { date, model, pricingTier, counts },
    );
  }

  /**
   * Adds a row imported from Cursor's usage CSV. Call it after every hook event: a row counts only when
   * strictly before the hook's first turn (all rows count when the hook never ran), so imported rows and
   * hook turns never overlap and are summed, not max-merged. Max Mode is not a pricing tier here: it
   * changes the context window, and Cursor's per-token rates do not differ for it.
   */
  addImported(row: ImportedRow): void {
    const instant = new Date(row.at);
    if (Number.isNaN(instant.getTime())) return;
    if (this.hookStart && instant >= this.hookStart) return;
    if (this.options.since && instant < this.options.since) return;
    const { model, pricingTier } = cursorModelIdentity({ model: row.model, modelId: row.model, fast: false });
    this.turns.set(`import\0${row.id}`, {
      date: dateKey(instant, this.options.timeZone),
      model,
      pricingTier,
      counts: {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheWriteTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreation5mTokens: null,
        cacheCreation1hTokens: null,
      },
    });
  }

  diagnostics(): CursorDiagnostics {
    return { ...this.counters };
  }

  result(): CollectResult {
    const buckets = new Map<string, DailyModelUsage>();
    for (const { date, model, pricingTier, counts } of this.turns.values()) {
      const key = `${date}\0${model}\0${pricingTier}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.counts = addSplitCounts(existing.counts, counts);
      } else {
        // Seeded from the counts themselves: adding to emptySplitCounts() would turn the null
        // cache split into 0.
        buckets.set(key, { date, model, pricingTier, counts: { ...counts } });
      }
    }
    const usage = [...buckets.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.model.localeCompare(b.model) || PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
    );
    return { source: CURSOR_SOURCE, usage, requestCount: this.turns.size };
  }
}
