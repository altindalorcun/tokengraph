import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readLines } from '../jsonl-files.js';
import { configHome } from '../../paths.js';
import type { CursorCsvRow } from './csv.js';
import { cursorEventsPath, parseCursorEvent } from './events.js';

/**
 * One row of a Cursor usage CSV (`tokengraph import cursor`), as stored in `cursor-import.jsonl`.
 * Like the event file it is never pruned: Cursor's dashboard export is the only record of that
 * history. `model` is the slug as the export wrote it; the adapter normalises it when it reads.
 */
export interface ImportedRow extends CursorCsvRow {
  /** SHA-256 of the row's fields plus its occurrence among identical rows of its CSV. */
  id: string;
}

export function cursorImportPath(): string {
  return join(configHome(), 'cursor-import.jsonl');
}

/**
 * Identical rows are legitimate (two equal requests in the same millisecond), so the id includes how
 * many identical rows came before in the same CSV: re-importing the same or an overlapping export
 * yields the same ids and adds nothing twice.
 */
export function importRowId(row: CursorCsvRow, occurrence: number): string {
  const fields = [
    row.at,
    row.model,
    row.maxMode ? '1' : '0',
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    occurrence,
  ];
  return createHash('sha256').update(fields.join('\u001f')).digest('hex');
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Drops anything malformed rather than throwing, like {@link parseCursorEvent}. */
export function parseImportedRow(line: string): ImportedRow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const fields = raw as Record<string, unknown>;
  const { id, at, model, maxMode } = fields;
  const inputTokens = count(fields['inputTokens']);
  const outputTokens = count(fields['outputTokens']);
  const cacheReadTokens = count(fields['cacheReadTokens']);
  const cacheWriteTokens = count(fields['cacheWriteTokens']);
  if (typeof id !== 'string' || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  if (typeof model !== 'string' || model.length === 0 || typeof maxMode !== 'boolean') return null;
  if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null) return null;
  return { id, at, model, maxMode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** Every stored row; a missing file yields none. */
export async function readImportedRows(): Promise<ImportedRow[]> {
  const rows: ImportedRow[] = [];
  try {
    await readLines(cursorImportPath(), (line) => {
      const row = parseImportedRow(line);
      if (row) rows.push(row);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  return rows;
}

/** When the hook first recorded a turn, or null before it has. Imported rows count only before this. */
export async function earliestHookEvent(): Promise<Date | null> {
  let earliest: Date | null = null;
  try {
    await readLines(cursorEventsPath(), (line) => {
      const event = parseCursorEvent(line);
      const instant = event ? new Date(event.receivedAt) : null;
      if (instant && !Number.isNaN(instant.getTime()) && (!earliest || instant < earliest)) earliest = instant;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  return earliest;
}
