import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { addDays, dateKey, emptyCounts, formatTokens, weightedTokens, type TokenCounts } from '@tokengraph/core';
import { createCursorAdapter } from '../adapters/cursor/index.js';
import { parseCursorCsv } from '../adapters/cursor/csv.js';
import { cursorImportPath, earliestHookEvent, importRowId, readImportedRows, type ImportedRow } from '../adapters/cursor/imports.js';
import { readConfig } from '../config.js';
import { mergeUsage, readLedger, writeLedger } from '../ledger.js';
import { configHome, ledgerPath } from '../paths.js';
import { acquireSyncLock } from '../sync-lock.js';

export interface ImportDeps {
  readFile: (path: string) => Promise<string>;
  loggedIn: () => Promise<boolean>;
}

const DEFAULT_DEPS: ImportDeps = {
  readFile: (path) => readFile(path, 'utf8'),
  loggedIn: async () => (await readConfig()).github !== undefined,
};

export const IMPORT_AGENTS = ['cursor'] as const;

/** Validates the positionals; returns the file to import, or the error message to print. */
export function parseImportArgs(positionals: readonly string[]): { agent: 'cursor'; file: string } | string {
  const [agent, file, ...extra] = positionals;
  if (agent === undefined) return `Say which agent to import: ${IMPORT_AGENTS.join(', ')}. Usage: tokengraph import cursor <file.csv>`;
  if (agent !== 'cursor') return `Cannot import "${agent}". Supported: ${IMPORT_AGENTS.join(', ')}.`;
  if (file === undefined || extra.length > 0) return 'Usage: tokengraph import cursor <file.csv>';
  return { agent, file };
}

/**
 * Stores a Cursor dashboard usage CSV in `cursor-import.jsonl` and folds it into the ledger the way
 * `sync --local` does for Cursor. Reads no credential and never publishes. The sync lock is held for the
 * whole run so a background sync cannot write the ledger underneath it.
 */
export async function runImportCursor(file: string, partial: Partial<ImportDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...partial };
  let text: string;
  try {
    text = await deps.readFile(file);
  } catch (error) {
    console.error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const parsed = parseCursorCsv(text);
  if (!parsed.ok) {
    console.error(`${file}: ${parsed.error}. Nothing was imported.`);
    return 1;
  }

  const lock = await acquireSyncLock();
  if (!lock.acquired) {
    console.error(`Another tokengraph sync is already running${lock.pid ? ` (pid ${lock.pid})` : ''}; try again in a minute.`);
    return 1;
  }
  try {
    return await importLocked(file, parsed, deps);
  } finally {
    await lock.release();
  }
}

async function importLocked(file: string, parsed: Extract<ReturnType<typeof parseCursorCsv>, { ok: true }>, deps: ImportDeps): Promise<number> {
  const known = new Set((await readImportedRows()).map((row) => row.id));
  const hookStart = await earliestHookEvent();

  const occurrences = new Map<string, number>();
  const fresh: ImportedRow[] = [];
  const eligible: ImportedRow[] = [];
  let already = 0;
  let afterHook = 0;
  for (const csvRow of parsed.rows) {
    // The occurrence counts identical rows across the whole CSV, including the ones skipped below.
    const key = JSON.stringify(csvRow);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    if (hookStart && new Date(csvRow.at) >= hookStart) {
      afterHook += 1;
      continue;
    }
    const row: ImportedRow = { id: importRowId(csvRow, occurrence), ...csvRow };
    eligible.push(row);
    if (known.has(row.id)) already += 1;
    else {
      known.add(row.id);
      fresh.push(row);
    }
  }

  if (fresh.length > 0) {
    await mkdir(configHome(), { recursive: true, mode: 0o700 });
    await appendFile(cursorImportPath(), fresh.map((row) => `${JSON.stringify(row)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
  }

  let added: TokenCounts = emptyCounts();
  for (const row of fresh) {
    added = {
      inputTokens: added.inputTokens + row.inputTokens,
      outputTokens: added.outputTokens + row.outputTokens,
      cacheCreationTokens: added.cacheCreationTokens + row.cacheWriteTokens,
      cacheReadTokens: added.cacheReadTokens + row.cacheReadTokens,
    };
  }

  if (eligible.length > 0) {
    // Two days of margin before the oldest row, so its whole local day is read whatever the time zone.
    const oldest = eligible.reduce((min, row) => (row.at < min ? row.at : min), eligible[0]!.at);
    const result = await createCursorAdapter().collect(addDays(new Date(oldest), -2));
    await mkdir(configHome(), { recursive: true, mode: 0o700 });
    await writeLedger(ledgerPath(), mergeUsage(await readLedger(ledgerPath()), result.source, result.usage));
  }

  const skipped = parsed.zero + parsed.malformed;
  const days = eligible.map((row) => dateKey(new Date(row.at))).sort();
  console.log(`Cursor usage CSV: ${file}`);
  console.log(`  rows read: ${parsed.rowsRead}`);
  console.log(`  newly imported: ${fresh.length}`);
  console.log(`  already imported: ${already}`);
  console.log(`  skipped (zero or malformed): ${skipped}${skipped > 0 ? ` (${parsed.zero} zero, ${parsed.malformed} malformed)` : ''}`);
  console.log(`  skipped as at or after hook start: ${afterHook}${hookStart ? ` (hook first ran ${hookStart.toISOString()})` : ''}`);
  if (days.length > 0) console.log(`  date range: ${days[0]} .. ${days[days.length - 1]}`);
  console.log(`  weighted tokens added: ${formatTokens(weightedTokens(added))}`);
  if (await deps.loggedIn()) console.log('\nRun `tokengraph sync` to publish.');
  return 0;
}
