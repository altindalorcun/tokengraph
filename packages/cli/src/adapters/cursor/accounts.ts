import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeAccountHours, mergeCursorAccount, type Ledger } from '../../ledger.js';
import { configHome } from '../../paths.js';
import { CursorUsageAggregator } from './aggregator.js';
import type { CursorCsvRow } from './csv.js';
import { importRowId, parseImportedRow, type ImportedRow } from './imports.js';
import { readLines } from '../jsonl-files.js';
import type { CursorFetchState } from './fetch-state.js';

/**
 * Raw rows fetched from cursor.com, one file per account: `cursor-account-<accountKey>.jsonl`, in the
 * import file's row shape and with its row ids, so fetching an overlapping window again adds nothing twice.
 * Never pruned. Only counters, timestamp, model and max-mode are kept (no prompts, no ids, no e-mail).
 */
const FILE = /^cursor-account-([0-9a-f]{16})\.jsonl$/;

export function cursorAccountPath(accountKey: string): string {
  return join(configHome(), `cursor-account-${accountKey}.jsonl`);
}

export async function listAccountKeys(): Promise<string[]> {
  try {
    return (await readdir(configHome())).flatMap((name) => FILE.exec(name)?.[1] ?? []).sort();
  } catch {
    return [];
  }
}

export async function readAccountRows(accountKey: string): Promise<ImportedRow[]> {
  const rows: ImportedRow[] = [];
  try {
    await readLines(cursorAccountPath(accountKey), (line) => {
      const row = parseImportedRow(line);
      if (row) rows.push(row);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  return rows;
}

/** Creates the account's file when no row has been stored yet, so a fetch that found no usage still counts as made. */
export async function ensureAccountFile(accountKey: string): Promise<void> {
  await mkdir(configHome(), { recursive: true, mode: 0o700 });
  await appendFile(cursorAccountPath(accountKey), '', { encoding: 'utf8', mode: 0o600 });
}

/**
 * Appends the rows of one response that are not stored yet. The id counts identical rows within the
 * response, which is why windows are whole UTC days: rows that share a timestamp share a day, so they are
 * in the same response whichever window fetched them. Returns how many rows were new.
 */
export async function appendAccountRows(accountKey: string, csvRows: readonly CursorCsvRow[]): Promise<number> {
  const known = new Set((await readAccountRows(accountKey)).map((row) => row.id));
  const occurrences = new Map<string, number>();
  const fresh: ImportedRow[] = [];
  for (const csvRow of csvRows) {
    const key = JSON.stringify(csvRow);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const row: ImportedRow = { id: importRowId(csvRow, occurrence), ...csvRow };
    if (known.has(row.id)) continue;
    known.add(row.id);
    fresh.push(row);
  }
  if (fresh.length > 0) {
    await mkdir(configHome(), { recursive: true, mode: 0o700 });
    await appendFile(cursorAccountPath(accountKey), fresh.map((row) => `${JSON.stringify(row)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
  }
  return fresh.length;
}

/**
 * Folds every stored account file into the ledger's `accounts.cursor` (max-merge). An account counts only
 * once a fetch has recorded how far it is covered; a file without that record is left out.
 */
export async function foldCursorAccounts(ledger: Ledger, state: CursorFetchState, timeZone?: string): Promise<Ledger> {
  let merged = ledger;
  for (const accountKey of await listAccountKeys()) {
    const coveredThrough = state.coveredThrough[accountKey];
    if (!coveredThrough) continue;
    const aggregator = new CursorUsageAggregator(timeZone ? { timeZone } : {});
    for (const row of await readAccountRows(accountKey)) aggregator.addImported(row);
    const result = aggregator.result();
    merged = mergeAccountHours(mergeCursorAccount(merged, accountKey, coveredThrough, result.usage), accountKey, result.hours);
  }
  return merged;
}
