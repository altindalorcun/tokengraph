import { writeFile } from 'node:fs/promises';
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
import { readLedger, type Ledger } from '../ledger.js';
import { ledgerPath } from '../paths.js';
import { combinedUsage, type MachineFile } from '../publish/machines.js';
import { readMachinesCache } from '../publish/machines-cache.js';

export type ExportFormat = 'csv' | 'json';

export interface ExportOptions {
  format: ExportFormat;
  out?: string;
  since?: string;
  allMachines?: boolean;
}

export interface ExportDeps {
  ledger: () => Promise<Ledger>;
  machines: () => Promise<MachineFile[]>;
}

const DEFAULT_DEPS: ExportDeps = {
  ledger: () => readLedger(ledgerPath()),
  machines: () => readMachinesCache(),
};

/** One row per day, agent, model and pricing tier. Costs are null when unpriced, splits when unknown. */
export interface ExportRow {
  date: string;
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
  return {
    format,
    since,
    out: typeof values['out'] === 'string' ? values['out'] : undefined,
    allMachines: values['all-machines'] === true,
  };
}

/**
 * Rows come from `combinedUsage`, one source at a time because it does not carry the agent. Machines
 * add up, so rows that share a key are summed (an unknown cache split stays unknown), and the cost
 * is the one the view and the story compute for the same counts.
 */
export function buildRows(ledger: Ledger, others: readonly MachineFile[], since?: string): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const source of KNOWN_SOURCES) {
    const only = (sources: Ledger['sources']): Ledger['sources'] => (sources[source] ? { [source]: sources[source] } : {});
    const merged = new Map<string, { date: string; model: string; tier: PricingTier; counts: SplitTokenCounts }>();
    const usage = combinedUsage(
      { ...ledger, sources: only(ledger.sources) },
      others.map((other) => ({ ...other, sources: only(other.sources) })),
      since,
    );
    for (const entry of usage) {
      const key = JSON.stringify([entry.date, entry.model, entry.pricingTier]);
      const existing = merged.get(key);
      if (existing) existing.counts = addSplitCounts(existing.counts, entry.counts);
      else merged.set(key, { date: entry.date, model: entry.model, tier: entry.pricingTier, counts: entry.counts });
    }
    for (const { date, model, tier, counts } of merged.values()) {
      const cost = costForSplitCounts(model, date, counts, tier);
      rows.push({
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
      });
    }
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort(
    (a, b) =>
      compare(a.date, b.date) ||
      compare(a.source, b.source) ||
      compare(a.model, b.model) ||
      PRICING_TIERS.indexOf(a.pricingTier) - PRICING_TIERS.indexOf(b.pricingTier),
  );
}

/** RFC 4180: quote only a field with a comma, a quote or a line break. */
function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function formatCsv(rows: readonly ExportRow[]): string {
  const lines = rows.map((row) =>
    [
      row.date, row.source, row.model, row.pricingTier, row.inputTokens, row.outputTokens, row.cacheWriteTokens,
      row.cacheWrite5mTokens, row.cacheWrite1hTokens, row.cacheReadTokens, row.weightedTokens, row.estimatedCostUsd,
    ]
      .map(csvField)
      .join(','),
  );
  return `${[CSV_HEADER.join(','), ...lines].join('\n')}\n`;
}

export function formatJson(rows: readonly ExportRow[], scope: 'this-machine' | 'all-machines'): string {
  return `${JSON.stringify({ schema: 1, scope, rows }, null, 2)}\n`;
}

export async function runExport(options: ExportOptions, overrides: Partial<ExportDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const ledger = await deps.ledger();
  const others = options.allMachines ? await deps.machines() : [];
  const rows = buildRows(ledger, others, options.since);
  const text = options.format === 'json' ? formatJson(rows, options.allMachines ? 'all-machines' : 'this-machine') : formatCsv(rows);
  if (options.out === undefined) {
    process.stdout.write(text);
    return 0;
  }
  try {
    await writeFile(options.out, text, 'utf8');
  } catch (error) {
    console.error(`Could not write ${options.out}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  process.stdout.write(`Wrote ${rows.length} rows to ${options.out}.\n`);
  return 0;
}
