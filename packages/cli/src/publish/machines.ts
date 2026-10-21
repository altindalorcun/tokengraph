import { createHash } from 'node:crypto';
import { combineMachineUsage, isKnownSource, type SourcedUsage } from '@tokengraph/core';
import {
  ledgerMachineUsage,
  LEDGER_VERSION,
  ledgerToUsage,
  mergeLedgerAccounts,
  mergeUsage,
  parseLedger,
  parseLedgerAccounts,
  type Ledger,
  type LedgerAccounts,
} from '../ledger.js';

export interface MachineFile {
  schema: 1;
  machineId: string;
  /** `<platform>-<first 6 of id>`: tells machines apart without a hostname, which can carry a name. */
  label: string;
  /** sha256 of the OS machine id and user name, for re-adopting this id after a reinstall. */
  fingerprint: string;
  cliVersion: string;
  updatedAt: string;
  sources: Ledger['sources'];
  /** Cursor accounts this machine fetched from cursor.com. Additive: older versions ignore it. */
  accounts?: LedgerAccounts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^machine-([0-9a-f-]{36})\.json$/i;

export function machineFileName(machineId: string): string {
  return `machine-${machineId}.json`;
}

export function isMachineFileName(name: string): boolean {
  const match = FILE_NAME.exec(name);
  return match !== null && UUID.test(match[1]!);
}

export function machineLabel(platform: NodeJS.Platform, machineId: string): string {
  return `${platform}-${machineId.slice(0, 6)}`;
}

export function parseMachineFile(content: string): MachineFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (f['schema'] !== 1) return null;
  const machineId = f['machineId'];
  if (typeof machineId !== 'string' || !UUID.test(machineId)) return null;
  const strings = ['label', 'fingerprint', 'cliVersion', 'updatedAt'] as const;
  for (const key of strings) if (typeof f[key] !== 'string') return null;
  const ledger = parseLedger({ version: LEDGER_VERSION, sources: f['sources'] });
  const accounts = parseLedgerAccounts(f['accounts']);
  return {
    schema: 1,
    machineId: machineId.toLowerCase(),
    label: f['label'] as string,
    fingerprint: f['fingerprint'] as string,
    cliVersion: f['cliVersion'] as string,
    updatedAt: f['updatedAt'] as string,
    sources: ledger.sources,
    ...(accounts ? { accounts } : {}),
  };
}

export function serializeMachineFile(file: MachineFile): string {
  // Compact: a few years of Cursor account days are over a megabyte pretty-printed. Readers accept both.
  return `${JSON.stringify(file)}\n`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Content identity of a machine's usage, independent of key order, to skip writes that change nothing. */
export function sourcesDigest(sources: Ledger['sources']): string {
  return createHash('sha256').update(JSON.stringify(stable(sources))).digest('hex');
}

/**
 * Content identity of what a machine file carries. Without accounts it is exactly `sourcesDigest`, so a
 * machine file written before accounts existed is not rewritten for nothing.
 */
export function usageDigest(content: { sources: Ledger['sources']; accounts?: LedgerAccounts | undefined }): string {
  if (!content.accounts) return sourcesDigest(content.sources);
  // coveredThrough enters as its UTC day: it moves with every fetch, and the file must not be rewritten each hour without new usage.
  const cursor = Object.fromEntries(
    Object.entries(content.accounts.cursor ?? {}).map(([key, account]) => [key, { ...account, coveredThrough: account.coveredThrough.slice(0, 10) }]),
  );
  return createHash('sha256').update(JSON.stringify(stable({ sources: content.sources, accounts: { ...content.accounts, cursor } }))).digest('hex');
}

/** Within one machine totals only grow: the gist copy can restore days the local ledger lost, never shrink any. */
export function maxMergeLedgers(base: Ledger, extra: Ledger['sources'], extraAccounts?: LedgerAccounts): Ledger {
  let merged = mergeLedgerAccounts(base, extraAccounts);
  const extraLedger: Ledger = { version: LEDGER_VERSION, sources: extra };
  for (const source of Object.keys(extra).filter(isKnownSource)) {
    merged = mergeUsage(merged, source, ledgerToUsage(extraLedger, source));
  }
  return merged;
}

export function activeDayCount(sources: Ledger['sources']): number {
  const dates = new Set<string>();
  for (const days of Object.values(sources)) for (const date of Object.keys(days ?? {})) dates.add(date);
  return dates.size;
}

/**
 * This machine's usage plus every other machine's: different machines are different usage, so they add up,
 * except a Cursor account fetched on several machines, which counts once (`combineMachineUsage` in core).
 */
export function combinedUsage(local: Ledger, others: readonly MachineFile[], sinceDate?: string): SourcedUsage[] {
  return combineMachineUsage([
    ledgerMachineUsage(local),
    ...others.map((other) => ledgerMachineUsage({ version: LEDGER_VERSION, sources: other.sources, ...(other.accounts ? { accounts: other.accounts } : {}) })),
  ]).filter((entry) => !sinceDate || entry.date >= sinceDate);
}

export function resolveMachineId(input: {
  configured?: string;
  files: readonly MachineFile[];
  fingerprint: string;
  newId: () => string;
}): { machineId: string; adopted: MachineFile | null } {
  if (input.configured) return { machineId: input.configured, adopted: null };
  const matches = input.files.filter((file) => file.fingerprint === input.fingerprint).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (matches[0]) return { machineId: matches[0].machineId, adopted: matches[0] };
  return { machineId: input.newId(), adopted: null };
}
