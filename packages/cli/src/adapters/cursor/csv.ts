/**
 * Parser for the usage CSV Cursor's dashboard exports (see docs/agents/cursor-usage.md, "CSV import").
 * Pure: no file access. Columns are found by header name, so a reordered or extended export still
 * parses. Prompts, file names and paths are not in this file, and the optional `Kind`, `Total Tokens`
 * and `Cost` columns are ignored.
 */

export interface CursorCsvRow {
  /** The row's `Date` as an ISO instant (UTC). */
  at: string;
  /** The model slug exactly as the export names it, trimmed. */
  model: string;
  maxMode: boolean;
  /** `Input (w/o Cache Write)`: input that was neither written to nor read from the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /**
   * `Input (w/ Cache Write)`: the input written to the cache. The two input columns do not overlap: in real
   * exports Total Tokens = w/ + w/o + Cache Read + Output on every row.
   */
  cacheWriteTokens: number;
}

export interface CursorCsvParse {
  ok: true;
  rows: CursorCsvRow[];
  /** Data rows in the file (blank lines excluded). */
  rowsRead: number;
  /** Rows whose date or a required count did not parse. */
  malformed: number;
  /** Rows whose counts are all zero (errored requests that were not charged). */
  zero: number;
}

export const NOT_A_CURSOR_EXPORT = 'not a Cursor usage export';

const COLUMNS = {
  date: 'Date',
  model: 'Model',
  inputWith: 'Input (w/ Cache Write)',
  inputWithout: 'Input (w/o Cache Write)',
  cacheRead: 'Cache Read',
  output: 'Output Tokens',
} as const;
const MAX_MODE_COLUMN = 'Max Mode';

/** RFC 4180 records: quoted fields, `""` escapes, CRLF or LF, newlines inside quotes. Blank lines are dropped. */
function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const endRecord = (): void => {
    record.push(field);
    field = '';
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') endRecord();
    else if (char !== '\r') field += char;
  }
  // A last record without a trailing newline (or an unterminated quote) still counts.
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** An ISO date or date-time. One without a time zone is read as UTC, so the result never depends on this machine. */
function parseInstant(value: string): string | null {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] = match;
  const offset = /^[+-]\d{4}$/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone.toUpperCase();
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${offset}`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * A token count, possibly quoted with thousands separators ("1,234"). A present-but-empty cell is 0 (real
 * exports leave Cache Read blank); a missing field (short row) or any other text is null.
 */
function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const cleaned = value.trim().replace(/,/g, '');
  if (cleaned === '') return 0;
  if (!/^\d+(\.0+)?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isSafeInteger(number) ? number : null;
}

export function parseCursorCsv(text: string): CursorCsvParse | { ok: false; error: string } {
  const [header, ...body] = parseRecords(text.replace(/^﻿/, ''));
  const names = (header ?? []).map((name) => name.trim());
  const required = Object.values(COLUMNS);
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length === required.length) return { ok: false, error: NOT_A_CURSOR_EXPORT };
  if (missing.length > 0) {
    return { ok: false, error: `missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` };
  }
  const at = (name: string): number => names.indexOf(name);
  const index = {
    date: at(COLUMNS.date),
    model: at(COLUMNS.model),
    inputWith: at(COLUMNS.inputWith),
    inputWithout: at(COLUMNS.inputWithout),
    cacheRead: at(COLUMNS.cacheRead),
    output: at(COLUMNS.output),
    maxMode: at(MAX_MODE_COLUMN),
  };

  const rows: CursorCsvRow[] = [];
  let malformed = 0;
  let zero = 0;
  for (const fields of body) {
    const instant = parseInstant(fields[index.date] ?? '');
    const inputWith = parseCount(fields[index.inputWith]);
    const inputWithout = parseCount(fields[index.inputWithout]);
    const cacheRead = parseCount(fields[index.cacheRead]);
    const output = parseCount(fields[index.output]);
    if (instant === null || inputWith === null || inputWithout === null || cacheRead === null || output === null) {
      malformed += 1;
      continue;
    }
    if (inputWith === 0 && inputWithout === 0 && cacheRead === 0 && output === 0) {
      zero += 1;
      continue;
    }
    rows.push({
      at: instant,
      model: (fields[index.model] ?? '').trim() || 'unknown',
      maxMode: index.maxMode >= 0 && /^(yes|true)$/i.test((fields[index.maxMode] ?? '').trim()),
      inputTokens: inputWithout,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: inputWith,
    });
  }
  return { ok: true, rows, rowsRead: body.length, malformed, zero };
}
