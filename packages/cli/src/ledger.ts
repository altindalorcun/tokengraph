import { readFile, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './fs-retry.js';
import {
  CLAUDE_CODE_SOURCE,
  emptySplitCounts,
  isDateKey,
  isKnownSource,
  isPricingTier,
  maxSplitCounts,
  PRICING_TIERS,
  type DailyModelUsage,
  type KnownSource,
  type PricingTier,
  type SplitTokenCounts,
} from '@tokengraph/core';

export const LEDGER_VERSION = 3;

/** date → model → pricing tier → counts. */
export type LedgerDays = Record<string, Record<string, Partial<Record<PricingTier, SplitTokenCounts>>>>;

export interface Ledger {
  version: typeof LEDGER_VERSION;
  sources: Partial<Record<KnownSource, LedgerDays>>;
}

export function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, sources: {} };
}

/**
 * Claude Code prunes old transcripts, so a later collection can legitimately see
 * *less* history than an earlier one. Past days never lose tokens, so merging by
 * per-field max keeps the ledger a high-water mark rather than a mirror of what
 * happens to be on disk right now. Each source and tier merges on its own.
 */
export function mergeUsage(ledger: Ledger, source: KnownSource, usage: readonly DailyModelUsage[]): Ledger {
  const days: LedgerDays = { ...(ledger.sources[source] ?? {}) };
  for (const entry of usage) {
    const models = { ...(days[entry.date] ?? {}) };
    const tiers = { ...(models[entry.model] ?? {}) };
    const current = tiers[entry.pricingTier];
    tiers[entry.pricingTier] = current ? maxSplitCounts(current, entry.counts) : entry.counts;
    models[entry.model] = tiers;
    days[entry.date] = models;
  }
  return { version: LEDGER_VERSION, sources: { ...ledger.sources, [source]: days } };
}

function tierOrder(tier: PricingTier): number {
  return PRICING_TIERS.indexOf(tier);
}

function compareUsage(a: DailyModelUsage, b: DailyModelUsage): number {
  return (
    a.date.localeCompare(b.date) || a.model.localeCompare(b.model) || tierOrder(a.pricingTier) - tierOrder(b.pricingTier)
  );
}

export function ledgerToUsage(ledger: Ledger, source: KnownSource, sinceDate?: string): DailyModelUsage[] {
  const usage: DailyModelUsage[] = [];
  for (const [date, models] of Object.entries(ledger.sources[source] ?? {})) {
    if (sinceDate && date < sinceDate) continue;
    for (const [model, tiers] of Object.entries(models)) {
      for (const [tier, counts] of Object.entries(tiers)) {
        if (counts && isPricingTier(tier)) usage.push({ date, model, pricingTier: tier, counts });
      }
    }
  }
  return usage.sort(compareUsage);
}

/** Every source's usage together — for totals and the preview graph, which do not split by agent. */
export function allLedgerUsage(ledger: Ledger, sinceDate?: string): DailyModelUsage[] {
  const sources = Object.keys(ledger.sources).filter(isKnownSource);
  return sources.flatMap((source) => ledgerToUsage(ledger, source, sinceDate)).sort(compareUsage);
}

const BASE_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const;

function readBaseFields(fields: Record<string, unknown>): Pick<SplitTokenCounts, (typeof BASE_FIELDS)[number]> | null {
  const counts = emptySplitCounts();
  for (const key of BASE_FIELDS) {
    const raw = fields[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
    counts[key] = Math.round(raw);
  }
  return counts;
}

/** A finite non-negative number, or explicitly null (unknown) — anything else is malformed. */
function readNullableField(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  return undefined;
}

/** v1 ledgers only ever held the four base fields — the cache-write split did not exist yet. */
function readLegacyCounts(value: unknown): SplitTokenCounts | null {
  if (typeof value !== 'object' || value === null) return null;
  const base = readBaseFields(value as Record<string, unknown>);
  if (!base) return null;
  return { ...base, cacheCreation5mTokens: null, cacheCreation1hTokens: null };
}

function readSplitCounts(value: unknown): SplitTokenCounts | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  const base = readBaseFields(fields);
  if (!base) return null;
  const cacheCreation5mTokens = readNullableField(fields['cacheCreation5mTokens']);
  const cacheCreation1hTokens = readNullableField(fields['cacheCreation1hTokens']);
  if (cacheCreation5mTokens === undefined || cacheCreation1hTokens === undefined) return null;
  return { ...base, cacheCreation5mTokens, cacheCreation1hTokens };
}

function parseModels(
  models: unknown,
  readTiers: (value: unknown) => Partial<Record<PricingTier, SplitTokenCounts>> | null,
): Record<string, Partial<Record<PricingTier, SplitTokenCounts>>> | null {
  if (typeof models !== 'object' || models === null) return null;
  const parsed: Record<string, Partial<Record<PricingTier, SplitTokenCounts>>> = {};
  for (const [model, value] of Object.entries(models as Record<string, unknown>)) {
    const tiers = readTiers(value);
    if (tiers) parsed[model] = tiers;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseDays(
  rawDays: unknown,
  readTiers: (value: unknown) => Partial<Record<PricingTier, SplitTokenCounts>> | null,
): LedgerDays | null {
  if (typeof rawDays !== 'object' || rawDays === null) return null;
  const days: LedgerDays = {};
  for (const [date, models] of Object.entries(rawDays as Record<string, unknown>)) {
    if (!isDateKey(date)) continue;
    const parsed = parseModels(models, readTiers);
    if (parsed) days[date] = parsed;
  }
  return Object.keys(days).length > 0 ? days : null;
}

/** Pre-v3 entries hold one set of counts per model: standard tier by definition. */
function legacyTiers(read: (value: unknown) => SplitTokenCounts | null) {
  return (value: unknown) => {
    const counts = read(value);
    return counts ? { standard: counts } : null;
  };
}

function readTiers(value: unknown): Partial<Record<PricingTier, SplitTokenCounts>> | null {
  if (typeof value !== 'object' || value === null) return null;
  const tiers: Partial<Record<PricingTier, SplitTokenCounts>> = {};
  for (const [tier, counts] of Object.entries(value as Record<string, unknown>)) {
    if (!isPricingTier(tier)) continue;
    const parsed = readSplitCounts(counts);
    if (parsed) tiers[tier] = parsed;
  }
  return Object.keys(tiers).length > 0 ? tiers : null;
}

/**
 * Drops anything malformed rather than throwing — a damaged ledger must not block a sync.
 *
 * A v1 ledger migrates in place rather than being reset: its entries become known-4-field /
 * unknown-split (cacheCreation5m/1hTokens: null), never 0. Zero would fabricate "no cache
 * writes happened" for days whose real split can no longer be recovered — Claude Code prunes
 * old transcripts, so there is no going back to re-derive it. A day still on disk self-heals
 * to a real value on the next sync; a pruned one stays unknown forever, which is correct.
 *
 * v1/v2 ledgers predate multiple sources and pricing tiers, so everything in them is Claude
 * Code usage at the standard tier.
 */
export function parseLedger(raw: unknown): Ledger {
  if (typeof raw !== 'object' || raw === null) return emptyLedger();
  const fields = raw as Record<string, unknown>;
  const version = fields['version'];

  if (version === 1 || version === 2) {
    const days = parseDays(fields['days'], legacyTiers(version === 1 ? readLegacyCounts : readSplitCounts));
    return days ? { version: LEDGER_VERSION, sources: { [CLAUDE_CODE_SOURCE]: days } } : emptyLedger();
  }
  if (version !== LEDGER_VERSION) return emptyLedger();

  const rawSources = fields['sources'];
  if (typeof rawSources !== 'object' || rawSources === null) return emptyLedger();
  const sources: Ledger['sources'] = {};
  for (const [source, rawDays] of Object.entries(rawSources as Record<string, unknown>)) {
    if (!isKnownSource(source)) continue;
    const days = parseDays(rawDays, readTiers);
    if (days) sources[source] = days;
  }
  return { version: LEDGER_VERSION, sources };
}

export async function readLedger(path: string): Promise<Ledger> {
  try {
    return parseLedger(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return emptyLedger();
  }
}

let writeCounter = 0;

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  // Per-process, per-call name: a Cursor hook and a Claude Code hook can start syncs at the
  // same moment, and even two calls in this process can land in the same millisecond.
  const temporary = `${path}.${process.pid}.${Date.now()}.${writeCounter++}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, path);
}
