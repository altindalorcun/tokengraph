import { describe, expect, it } from 'vitest';
import { parseCursorCsv } from '../src/adapters/cursor/csv.js';

const HEADER = 'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost';

function ok(text: string) {
  const result = parseCursorCsv(text);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result;
}

describe('parseCursorCsv', () => {
  it('maps the columns to counts: cache write is the difference of the two input columns', () => {
    const { rows, rowsRead } = ok(`${HEADER}\n2026-05-02T10:00:00.000Z,Included,claude-4.5-sonnet,No,1500,1000,200,50,1750,0.01\n`);
    expect(rowsRead).toBe(1);
    expect(rows).toEqual([
      { at: '2026-05-02T10:00:00.000Z', model: 'claude-4.5-sonnet', maxMode: false, inputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 200, outputTokens: 50 },
    ]);
  });

  it('finds columns by name in any order, with optional columns absent', () => {
    const { rows } = ok('Output Tokens,Cache Read,Input (w/o Cache Write),Input (w/ Cache Write),Model,Date\n7,3,10,10,gpt-5,2026-05-02T10:00:00Z\n');
    expect(rows[0]).toMatchObject({ outputTokens: 7, cacheReadTokens: 3, inputTokens: 10, cacheWriteTokens: 0, model: 'gpt-5', maxMode: false });
  });

  it('clamps cache write to 0 when with-cache-write is below without', () => {
    expect(ok(`${HEADER}\n2026-05-02T10:00:00Z,x,m,No,5,9,0,1,0,0\n`).rows[0]?.cacheWriteTokens).toBe(0);
  });

  it('handles a BOM, CRLF, quoted fields, escaped quotes, thousands separators and quoted numbers', () => {
    const text =
      `﻿${HEADER}\r\n` +
      '"2026-05-02T10:00:00Z","Included","my ""odd"", model","Yes","1,500","1,000","2,000","3","x","0"\r\n';
    const { rows } = ok(text);
    expect(rows).toEqual([
      { at: '2026-05-02T10:00:00.000Z', model: 'my "odd", model', maxMode: true, inputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 2000, outputTokens: 3 },
    ]);
  });

  it('keeps a newline inside a quoted field in one record', () => {
    const { rows, rowsRead } = ok(`${HEADER}\n2026-05-02T10:00:00Z,"a\nb",model,No,1,1,0,1,2,0\n`);
    expect(rowsRead).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('reads a Date without a time zone as UTC, and applies an offset when there is one', () => {
    const { rows } = ok(
      `${HEADER}\n2026-05-02 10:00:00,k,m,No,1,1,0,1,2,0\n2026-05-02T10:00:00+02:00,k,m,No,1,1,0,1,2,0\n2026-05-02,k,m,No,1,1,0,1,2,0\n`,
    );
    expect(rows.map((row) => row.at)).toEqual(['2026-05-02T10:00:00.000Z', '2026-05-02T08:00:00.000Z', '2026-05-02T00:00:00.000Z']);
  });

  it('counts rows with an unparseable date or count as malformed, and all-zero rows as zero', () => {
    const result = ok(
      [
        HEADER,
        'not a date,k,m,No,1,1,0,1,2,0',
        '2026-05-02T10:00:00Z,k,m,No,abc,1,0,1,2,0',
        '2026-05-02T10:00:00Z,k,m,No,1,1',
        '2026-05-02T10:00:00Z,k,m,No,0,0,0,0,0,0',
        '2026-05-02T10:00:00Z,k,m,No,1,1,0,1,2,0',
        '',
      ].join('\n'),
    );
    expect(result).toMatchObject({ rowsRead: 5, malformed: 3, zero: 1 });
    expect(result.rows).toHaveLength(1);
  });

  it('counts a present-but-empty count cell as 0 (a blank Cache Read is common in real exports)', () => {
    expect(ok(`${HEADER}\n2026-05-02T10:00:00Z,k,m,No,1500,1000,,50,0,0\n`)).toMatchObject({
      malformed: 0,
      rows: [{ inputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 0, outputTokens: 50 }],
    });
    const rows = ok(
      [
        HEADER,
        '2026-05-02T10:00:00Z,k,m,No,,1000,7,50,0,0',
        '2026-05-02T10:00:00Z,k,m,No,1500,,7,50,0,0',
        '2026-05-02T10:00:00Z,k,m,No,1500,1000,7,,0,0',
      ].join('\n'),
    );
    expect(rows.malformed).toBe(0);
    expect(rows.rows.map((r) => [r.inputTokens, r.cacheWriteTokens, r.cacheReadTokens, r.outputTokens])).toEqual([
      [1000, 0, 7, 50],
      [0, 1500, 7, 50],
      [1000, 500, 7, 0],
    ]);
  });

  it('skips a row whose count cells are all blank as zero, and keeps a short row malformed', () => {
    const result = ok(`${HEADER}\n2026-05-02T10:00:00Z,k,m,No,,,,,,\n2026-05-02T10:00:00Z,k,m,No,1500,1000\n`);
    expect(result).toMatchObject({ rows: [], zero: 1, malformed: 1 });
  });

  it('names every missing required column', () => {
    const result = parseCursorCsv('Date,Model,Output Tokens\n2026-05-02,m,1\n');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Input (w/ Cache Write), Input (w/o Cache Write), Cache Read') });
  });

  it('rejects a file with none of the required columns as not a Cursor export', () => {
    for (const text of ['', 'a,b,c\n1,2,3\n', '\n\n']) {
      expect(parseCursorCsv(text)).toEqual({ ok: false, error: 'not a Cursor usage export' });
    }
  });

  it('accepts a header-only export', () => {
    expect(ok(`${HEADER}\n`)).toMatchObject({ rows: [], rowsRead: 0 });
  });
});
