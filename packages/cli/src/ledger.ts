import { clampInstant } from './clamp-instant.js';
import { readFile, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './fs-retry.js';
import {
  CLAUDE_CODE_SOURCE,
  combineMachineUsage,
  combineMachineHours,
  CURSOR_SOURCE,
  emptySplitCounts,
  isDateKey,
  isKnownSource,
  isPricingTier,
  maxSplitCounts,
  PRICING_TIERS,
  type DailyModelUsage,
  type HourDays,
  type HourlyUsage,
  type MachineHours,
  type SourcedHourly,
  type KnownSource,
  type MachineUsage,
  type PricingTier,
  type SourcedUsage,
  type SplitTokenCounts,
} from '@tokengraph/core';

export const LEDGER_VERSION = 3;

/** date → model → pricing tier → counts. */
export type LedgerDays = Record<string, Record<string, Partial<Record<PricingTier, SplitTokenCounts>>>>;

/** One Cursor account as fetched from cursor.com: complete up to `coveredThrough` (an ISO instant). */
export interface LedgerAccount {
  coveredThrough: string;
  days: LedgerDays;
}

/** Account-level usage, keyed by account key. Additive: ledgers and machine files without it still parse, and older versions ignore it. */
export interface LedgerAccounts {
  cursor?: Record<string, LedgerAccount>;
}

export interface Ledger {
  version: typeof LEDGER_VERSION;
  sources: Partial<Record<KnownSource, LedgerDays>>;
  accounts?: LedgerAccounts;
  /**
   * Weighted tokens per local hour: source → date → hour → tokens. Local only: it is never copied into a
   * machine file or a gist (hours describe a person's day). Additive; a ledger without it still parses.
   */
  hours?: Partial<Record<KnownSource, HourDays>>;
  /** Cursor account hours (account key → date → hour → tokens), kept apart from the `cursor` source's hook hours. */
  accountHours?: Record<string, HourDays>;
}

/** The first 16 hex digits of a SHA-256: what an account key looks like. */
export const ACCOUNT_KEY = /^[0-9a-f]{16}$/;

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
  return { ...ledger, version: LEDGER_VERSION, sources: { ...ledger.sources, [source]: days } };
}

function maxMergeHourDays(base: HourDays | undefined, rows: readonly HourlyUsage[]): HourDays {
  const days: HourDays = { ...(base ?? {}) };
  for (const { date, hour, weighted } of rows) {
    const hours = { ...(days[date] ?? {}) };
    hours[String(hour)] = Math.max(hours[String(hour)] ?? 0, weighted);
    days[date] = hours;
  }
  return days;
}

function hourRows(days: HourDays | undefined): HourlyUsage[] {
  return Object.entries(days ?? {}).flatMap(([date, hours]) => Object.entries(hours).map(([hour, weighted]) => ({ date, hour: Number(hour), weighted })));
}

/** Max-merges one source's hour totals (a high-water mark per date and hour, like the daily counts). */
export function mergeHours(ledger: Ledger, source: KnownSource, rows: readonly HourlyUsage[] | undefined): Ledger {
  if (!rows || rows.length === 0) return ledger;
  return { ...ledger, hours: { ...ledger.hours, [source]: maxMergeHourDays(ledger.hours?.[source], rows) } };
}

export function mergeAccountHours(ledger: Ledger, accountKey: string, rows: readonly HourlyUsage[] | undefined): Ledger {
  if (!rows || rows.length === 0) return ledger;
  return { ...ledger, accountHours: { ...ledger.accountHours, [accountKey]: maxMergeHourDays(ledger.accountHours?.[accountKey], rows) } };
}

/** Max-merges every hour table of `extra` into `ledger` (another copy of this machine's own ledger). */
export function mergeLedgerHours(ledger: Ledger, extra: Pick<Ledger, 'hours' | 'accountHours'>): Ledger {
  let merged = ledger;
  for (const [source, days] of Object.entries(extra.hours ?? {}) as [KnownSource, HourDays][]) merged = mergeHours(merged, source, hourRows(days));
  for (const [key, days] of Object.entries(extra.accountHours ?? {})) merged = mergeAccountHours(merged, key, hourRows(days));
  return merged;
}

/** This machine's hours as the pure combining rule takes them (`combineMachineHours` in core). */
export function ledgerMachineHours(ledger: Ledger): MachineHours {
  const accounts: MachineHours['accounts'] = Object.fromEntries(
    Object.entries(ledger.accountHours ?? {}).flatMap(([key, hours]) => {
      const covered = ledger.accounts?.cursor?.[key]?.coveredThrough;
      return covered ? [[key, { coveredThrough: covered, hours }]] : [];
    }),
  );
  return { sources: ledger.hours ?? {}, accounts };
}

/** Every agent's hour totals on this machine, the Cursor account rule applied. */
export function allLedgerHours(ledger: Ledger, sinceDate?: string): SourcedHourly[] {
  return combineMachineHours(ledgerMachineHours(ledger)).filter((row) => !sinceDate || row.date >= sinceDate);
}

/** Max-merges one Cursor account's days into the ledger and moves its `coveredThrough` forward, never back. */
export function mergeCursorAccount(ledger: Ledger, accountKey: string, coveredThrough: string, usage: readonly DailyModelUsage[]): Ledger {
  const accounts = ledger.accounts?.cursor ?? {};
  const existing = accounts[accountKey];
  const merged = mergeUsage({ version: LEDGER_VERSION, sources: { [CURSOR_SOURCE]: existing?.days ?? {} } }, CURSOR_SOURCE, usage);
  const incoming = clampInstant(coveredThrough) ?? coveredThrough;
  const known = existing ? (clampInstant(existing.coveredThrough) ?? existing.coveredThrough) : undefined;
  const covered = known && known > incoming ? known : incoming;
  return {
    ...ledger,
    accounts: { ...ledger.accounts, cursor: { ...accounts, [accountKey]: { coveredThrough: covered, days: merged.sources[CURSOR_SOURCE] ?? {} } } },
  };
}

/** Max-merges every account in `extra` (another copy of the same ledger, such as this machine's file in the data gist). */
export function mergeLedgerAccounts(ledger: Ledger, extra: LedgerAccounts | undefined): Ledger {
  let merged = ledger;
  for (const [key, account] of Object.entries(extra?.cursor ?? {})) {
    merged = mergeCursorAccount(merged, key, account.coveredThrough, accountUsage(account));
  }
  return merged;
}

function accountUsage(account: LedgerAccount): DailyModelUsage[] {
  return ledgerToUsage({ version: LEDGER_VERSION, sources: { [CURSOR_SOURCE]: account.days } }, CURSOR_SOURCE);
}

/** A ledger as the pure combining rule takes it (`combineMachineUsage` in core). */
export function ledgerMachineUsage(ledger: Ledger): MachineUsage {
  const usage: SourcedUsage[] = Object.keys(ledger.sources)
    .filter(isKnownSource)
    .flatMap((source) => ledgerToUsage(ledger, source).map((entry) => ({ ...entry, source })));
  const accounts = Object.fromEntries(
    Object.entries(ledger.accounts?.cursor ?? {}).map(([key, account]) => [key, { coveredThrough: account.coveredThrough, usage: accountUsage(account) }]),
  );
  return { usage, accounts };
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

/**
 * Every source's usage together — for totals and the preview graph, which do not split by agent. This machine's
 * Cursor account figures replace its hook and import rows where they overlap (see `combineMachineUsage`).
 */
export function allLedgerUsage(ledger: Ledger, sinceDate?: string): SourcedUsage[] {
  return combineMachineUsage([ledgerMachineUsage(ledger)])
    .filter((entry) => !sinceDate || entry.date >= sinceDate)
    .sort(compareUsage);
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

/** Hour tables are tolerant: a bad date, hour or amount is dropped. */
function parseHourDays(raw: unknown): HourDays | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const days: HourDays = {};
  for (const [date, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDateKey(date) || typeof value !== 'object' || value === null) continue;
    const hours: Record<string, number> = {};
    for (const [hour, amount] of Object.entries(value as Record<string, unknown>)) {
      const h = Number(hour);
      if (Number.isInteger(h) && h >= 0 && h <= 23 && typeof amount === 'number' && Number.isFinite(amount) && amount > 0) hours[String(h)] = Math.round(amount);
    }
    if (Object.keys(hours).length > 0) days[date] = hours;
  }
  return Object.keys(days).length > 0 ? days : null;
}

/** Account entries are tolerant: a bad key, instant or day is dropped, an account with no valid days is kept (it still says how far it is covered). */
function parseAccounts(raw: unknown): LedgerAccounts | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rawCursor = (raw as Record<string, unknown>)['cursor'];
  if (typeof rawCursor !== 'object' || rawCursor === null) return undefined;
  const cursor: Record<string, LedgerAccount> = {};
  for (const [key, value] of Object.entries(rawCursor as Record<string, unknown>)) {
    if (!ACCOUNT_KEY.test(key) || typeof value !== 'object' || value === null) continue;
    const { coveredThrough, days } = value as Record<string, unknown>;
    if (typeof coveredThrough !== 'string' || Number.isNaN(Date.parse(coveredThrough))) continue;
    cursor[key] = { coveredThrough: clampInstant(coveredThrough)!, days: parseDays(days, readTiers) ?? {} };
  }
  return Object.keys(cursor).length > 0 ? { cursor } : undefined;
}

/** For machine files, which carry the same `accounts` field as the ledger. */
export function parseLedgerAccounts(raw: unknown): LedgerAccounts | undefined {
  return parseAccounts(raw);
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
  const accounts = parseAccounts(fields['accounts']);
  const rawHours = fields['hours'];
  const hours: NonNullable<Ledger['hours']> = {};
  if (typeof rawHours === 'object' && rawHours !== null) {
    for (const [source, value] of Object.entries(rawHours as Record<string, unknown>)) {
      const parsed = isKnownSource(source) ? parseHourDays(value) : null;
      if (parsed) hours[source as KnownSource] = parsed;
    }
  }
  const rawAccountHours = fields['accountHours'];
  const accountHours: Record<string, HourDays> = {};
  if (typeof rawAccountHours === 'object' && rawAccountHours !== null) {
    for (const [key, value] of Object.entries(rawAccountHours as Record<string, unknown>)) {
      const parsed = ACCOUNT_KEY.test(key) ? parseHourDays(value) : null;
      if (parsed) accountHours[key] = parsed;
    }
  }
  return {
    version: LEDGER_VERSION,
    sources,
    ...(accounts ? { accounts } : {}),
    ...(Object.keys(hours).length > 0 ? { hours } : {}),
    ...(Object.keys(accountHours).length > 0 ? { accountHours } : {}),
  };
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
