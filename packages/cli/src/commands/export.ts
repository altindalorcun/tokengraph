import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import {
  addSplitCounts,
  costForSplitCounts,
  isDateKey,
  KNOWN_SOURCES,
  PRICING_TIERS,
  weightedTokens,
  type KnownSource,
  type PricingTier,
  type SplitTokenCounts,
} from '@tokengraph/core';
import { readConfig } from '../config.js';
import { allLedgerHours, readLedger, type Ledger } from '../ledger.js';
import { ledgerPath } from '../paths.js';
import { NOT_ASSIGNED, projectRows, type ProjectRow } from '../project-usage.js';
import { combinedUsage, type MachineFile } from '../publish/machines.js';
import { readMachinesCache } from '../publish/machines-cache.js';

export type ExportFormat = 'csv' | 'json';

export interface ExportOptions {
  format: ExportFormat;
  out?: string;
  since?: string;
  allMachines?: boolean;
  /** One row per day, project, agent, model and tier. This machine only. */
  projects?: boolean;
  /** Hour-of-day rows (this machine only) instead of daily rows. */
  hours?: boolean;
}

export interface ExportDeps {
  ledger: () => Promise<Ledger>;
  machines: () => Promise<MachineFile[]>;
  projectNames: () => Promise<Record<string, string>>;
  home: () => string;
}

const DEFAULT_DEPS: ExportDeps = {
  ledger: () => readLedger(ledgerPath()),
  machines: () => readMachinesCache(),
  projectNames: async () => (await readConfig()).projects?.names ?? {},
  home: () => homedir(),
};

/** One row per day, agent, model and pricing tier. Costs are null when unpriced, splits when unknown. */
export interface ExportRow {
  date: string;
  /** The project's name, with `--projects`. Never its path: this file is made to be sent to someone. */
  project?: string;
  source: KnownSource;
  model: string;
  pricingTier: PricingTier;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  cacheReadTokens: number;
  weightedTokens: number;
  estimatedCostUsd: number | null;
}

const CSV_HEADER = [
  'date', 'source', 'model', 'pricing_tier', 'input_tokens', 'output_tokens', 'cache_write_tokens',
  'cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_read_tokens', 'weighted_tokens', 'estimated_cost_usd',
];

/** Validates the raw flags; returns the options, or the error message to print. */
export function parseExportArgs(values: Record<string, string | boolean | undefined>): ExportOptions | string {
  const format = values['format'] ?? 'csv';
  if (format !== 'csv' && format !== 'json') return '--format must be csv or json.';
  const since = values['since'];
  if (since !== undefined && (typeof since !== 'string' || !isDateKey(since))) return '--since must be a date as YYYY-MM-DD.';
  if (values['projects'] === true && values['all-machines'] === true) return '--projects is for this machine only; it cannot be combined with --all-machines.';
  if (values['projects'] === true && values['hours'] === true) return '--projects cannot be combined with --hours.';
  if (values['hours'] === true && values['all-machines'] === true) return '--hours is for this machine only; it cannot be combined with --all-machines.';
  return {
    format,
    since,
    out: typeof values['out'] === 'string' ? values['out'] : undefined,
    allMachines: values['all-machines'] === true,
    ...(values['hours'] === true ? { hours: true } : {}),
    ...(values['projects'] === true ? { projects: true } : {}),
  };
}

function exportRow(date: string, source: KnownSource, model: string, tier: PricingTier, counts: SplitTokenCounts): ExportRow {
  const cost = costForSplitCounts(model, date, counts, tier);
  return {
    date,
    source,
    model,
    pricingTier: tier,
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    cacheWriteTokens: counts.cacheCreationTokens,
    cacheWrite5mTokens: counts.cacheCreation5mTokens,
    cacheWrite1hTokens: counts.cacheCreation1hTokens,
    cacheReadTokens: counts.cacheReadTokens,
    weightedTokens: weightedTokens(counts),
    estimatedCostUsd: cost.priced ? Math.round(cost.dollars * 1e6) / 1e6 : null,
  };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Export rows per project, from this machine's ledger. Roots that share a name sum, as they do everywhere else. */
export function buildProjectRows(ledger: Ledger, names: Readonly<Record<string, string>>, home: string, since?: string): ExportRow[] {
  const merged = new Map<string, ProjectRow>();
  for (const row of projectRows(ledger, names, home)) {
    if (since !== undefined && row.date < since) continue;
    const key = JSON.stringify([row.date, row.project, row.source, row.model, row.pricingTier]);
    const existing = merged.get(key);
    if (existing) existing.counts = addSplitCounts(existing.counts, row.counts);
    else merged.set(key, { ...row });
  }
  return [...merged.values()]
    .map((row) => ({ ...exportRow(row.date, row.source, row.model, row.pricingTier, row.counts), project: row.project }))
    .sort(
      (a, b) =>
        compareText(a.date, b.date) ||
        Number(a.project === NOT_ASSIGNED) - Number(b.project === NOT_ASSIGNED) ||
        compareText(a.project, b.project) ||
        compareText(a.source, b.source) ||
        compareText(a.model, b.model) ||
        PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
    );
}

/**
 * Rows come from `combinedUsage`, which carries the agent. Machines add up (a Cursor account fetched on
 * several machines counts once), so rows that share a key are summed (an unknown cache split stays unknown), and the cost
 * is the one the view and the story compute for the same counts.
 */
export function buildRows(ledger: Ledger, others: readonly MachineFile[], since?: string): ExportRow[] {
  const rows: ExportRow[] = [];
  const everything = combinedUsage(ledger, others, since);
  for (const source of KNOWN_SOURCES) {
    const merged = new Map<string, { date: string; model: string; tier: PricingTier; counts: SplitTokenCounts }>();
    for (const entry of everything) {
      if (entry.source !== source) continue;
      const key = JSON.stringify([entry.date, entry.model, entry.pricingTier]);
      const existing = merged.get(key);
      if (existing) existing.counts = addSplitCounts(existing.counts, entry.counts);
      else merged.set(key, { date: entry.date, model: entry.model, tier: entry.pricingTier, counts: entry.counts });
    }
    for (const { date, model, tier, counts } of merged.values()) rows.push(exportRow(date, source, model, tier, counts));
  }
  return rows.sort(
    (a, b) =>
      compareText(a.date, b.date) ||
      compareText(a.source, b.source) ||
      compareText(a.model, b.model) ||
      PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
  );
}

/** One row per day, local hour and agent: weighted tokens only. */
export interface HourExportRow {
  date: string;
  hour: number;
  source: KnownSource;
  weightedTokens: number;
}

/** Hour rows come from this machine's ledger only (hour data is never published or merged across machines). */
export function buildHourRows(ledger: Ledger, since?: string): HourExportRow[] {
  return allLedgerHours(ledger, since).map((row) => ({ date: row.date, hour: row.hour, source: row.source, weightedTokens: row.weighted }));
}

export function formatHoursCsv(rows: readonly HourExportRow[]): string {
  return `${['date,hour,source,weighted_tokens', ...rows.map((row) => `${row.date},${row.hour},${row.source},${row.weightedTokens}`)].join('\n')}\n`;
}

export function formatHoursJson(rows: readonly HourExportRow[]): string {
  return `${JSON.stringify({ schema: 1, scope: 'this-machine', rows }, null, 2)}\n`;
}

/** RFC 4180: quote only a field with a comma, a quote or a line break. */
function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A project name comes from a folder, and this file gets opened in spreadsheets: a leading quote keeps it text, not a formula. */
function spreadsheetSafe(text: string | undefined): string | null {
  if (text === undefined) return null;
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function formatCsv(rows: readonly ExportRow[], withProject = false): string {
  const header = withProject ? ['date', 'project', ...CSV_HEADER.slice(1)] : CSV_HEADER;
  const lines = rows.map((row) =>
    [
      row.date, ...(withProject ? [spreadsheetSafe(row.project)] : []), row.source, row.model, row.pricingTier, row.inputTokens, row.outputTokens, row.cacheWriteTokens,
      row.cacheWrite5mTokens, row.cacheWrite1hTokens, row.cacheReadTokens, row.weightedTokens, row.estimatedCostUsd,
    ]
      .map(csvField)
      .join(','),
  );
  return `${[header.join(','), ...lines].join('\n')}\n`;
}

export function formatJson(rows: readonly ExportRow[], scope: 'this-machine' | 'all-machines'): string {
  return `${JSON.stringify({ schema: 1, scope, rows }, null, 2)}\n`;
}

export async function runExport(options: ExportOptions, overrides: Partial<ExportDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const ledger = await deps.ledger();
  const others = options.allMachines ? await deps.machines() : [];
  let rowCount: number;
  let text: string;
  if (options.hours) {
    const hourRows = buildHourRows(ledger, options.since);
    rowCount = hourRows.length;
    text = options.format === 'json' ? formatHoursJson(hourRows) : formatHoursCsv(hourRows);
  } else {
    const rows = options.projects ? buildProjectRows(ledger, await deps.projectNames(), deps.home(), options.since) : buildRows(ledger, others, options.since);
    rowCount = rows.length;
    text = options.format === 'json' ? formatJson(rows, options.allMachines ? 'all-machines' : 'this-machine') : formatCsv(rows, options.projects === true);
  }
  if (options.out === undefined) {
    process.stdout.write(text);
    return 0;
  }
  try {
    // Like `story --out`, a folder that does not exist yet is created.
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, text, 'utf8');
  } catch (error) {
    console.error(`Could not write ${options.out}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  process.stdout.write(`Wrote ${rowCount} rows to ${options.out}.\n`);
  return 0;
}
