import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCursorAdapter } from '../src/adapters/cursor/index.js';
import { parseImportArgs, runImportCursor } from '../src/commands/import.js';
import { ledgerToUsage, readLedger } from '../src/ledger.js';

const HEADER = 'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost';

function csv(...rows: string[]): string {
  return `${HEADER}\n${rows.join('\n')}\n`;
}

function eventLine(receivedAt: string, generationId = 'g1'): string {
  return JSON.stringify({
    v: 1, receivedAt, generationId, model: 'composer-2.5', modelId: 'composer-2.5', fast: false, status: 'completed',
    cursorVersion: '3.0', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
  });
}

describe('tokengraph import cursor', () => {
  const saved = process.env['TOKENGRAPH_HOME'];
  let home: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tg-cursor-import-'));
    process.env['TOKENGRAPH_HOME'] = home;
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => void err.push(line));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
  });

  const run = (text: string, loggedIn = false) =>
    runImportCursor('export.csv', { readFile: async () => text, loggedIn: async () => loggedIn });
  const importFile = (): string => join(home, 'cursor-import.jsonl');

  it('accepts only cursor as the agent', () => {
    expect(parseImportArgs(['cursor', 'a.csv'])).toEqual({ agent: 'cursor', file: 'a.csv' });
    expect(parseImportArgs(['claude-code', 'a.csv'])).toContain('Supported: cursor');
    expect(parseImportArgs([])).toContain('cursor');
    expect(parseImportArgs(['cursor'])).toContain('Usage');
  });

  it('stores rows (mode 0600) and updates the ledger with normalised models', async () => {
    const text = csv(
      '2026-05-02T10:00:00Z,Included,claude-4.5-opus-high-thinking,Yes,1500,1000,200,50,2750,0.1',
      '2026-05-02T11:00:00Z,Included,composer-2.5-fast,No,10,10,0,5,25,0',
      '2026-05-03T11:00:00Z,Included,gpt-5,No,0,0,0,0,0,0',
      'broken,Included,gpt-5,No,1,1,0,1,2,0',
    );
    expect(await run(text, true)).toBe(0);
    const lines = (await readFile(importFile(), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      at: '2026-05-02T10:00:00.000Z', model: 'claude-4.5-opus-high-thinking', maxMode: true,
      inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 1500,
    });
    expect(typeof lines[0].id).toBe('string');
    if (process.platform !== 'win32') expect((await stat(importFile())).mode & 0o777).toBe(0o600);

    const usage = ledgerToUsage(await readLedger(join(home, 'state.json')), 'cursor');
    const models = usage.map((entry) => `${entry.model}/${entry.pricingTier}`).sort();
    expect(models).toEqual(['claude-opus-4-5/standard', 'composer-2.5-fast/standard']);
    expect(usage.find((entry) => entry.model === 'claude-opus-4-5')?.counts).toMatchObject({
      inputTokens: 1000, cacheCreationTokens: 1500, cacheReadTokens: 200, outputTokens: 50, cacheCreation5mTokens: null,
    });

    expect(out.join('\n')).toContain('rows read: 4');
    expect(out.join('\n')).toContain('newly imported: 2');
    expect(out.join('\n')).toContain('skipped (zero or malformed): 2 (1 zero, 1 malformed)');
    expect(out.join('\n')).toContain('date range: 2026-05-02 .. 2026-05-02');
    expect(out.join('\n')).toContain('weighted tokens added:');
    expect(out.join('\n')).toContain('Run `tokengraph sync` to publish.');
  });

  it('does not suggest publishing when not logged in', async () => {
    await run(csv('2026-05-02T10:00:00Z,k,gpt-5,No,5,5,0,5,10,0'));
    expect(out.join('\n')).not.toContain('tokengraph sync');
  });

  it('is idempotent, also for an overlapping export, and keeps identical rows distinct', async () => {
    const same = '2026-05-02T10:00:00Z,k,gpt-5,No,5,5,0,5,10,0';
    const other = '2026-05-02T12:00:00Z,k,gpt-5,No,7,7,0,7,14,0';
    await run(csv(same, same));
    await run(csv(same, same));
    await run(csv(same, same, other));
    expect((await readFile(importFile(), 'utf8')).trim().split('\n')).toHaveLength(3);
    out.length = 0;
    await run(csv(same, same, other));
    expect(out.join('\n')).toContain('newly imported: 0');
    expect(out.join('\n')).toContain('already imported: 3');
    const usage = ledgerToUsage(await readLedger(join(home, 'state.json')), 'cursor');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.counts.inputTokens).toBe(5 + 5 + 7);
  });

  it('skips rows at or after the first hook event and reports them', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'cursor-events.jsonl'), `${eventLine('2026-05-02T10:00:00.000Z')}\n`);
    expect(
      await run(
        csv(
          '2026-05-02T09:59:59Z,k,gpt-5,No,5,5,0,5,10,0',
          '2026-05-02T10:00:00Z,k,gpt-5,No,6,6,0,6,12,0',
          '2026-05-02T10:00:01Z,k,gpt-5,No,7,7,0,7,14,0',
        ),
      ),
    ).toBe(0);
    expect(out.join('\n')).toContain('newly imported: 1');
    expect(out.join('\n')).toContain('skipped as at or after hook start: 2');
    expect((await readFile(importFile(), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('rejects a file that is not a Cursor export, or lacks a column, and writes nothing', async () => {
    expect(await run('a,b\n1,2\n')).toBe(1);
    expect(err.join('\n')).toContain('not a Cursor usage export');
    expect(await run('Date,Model\n2026-05-02,x\n')).toBe(1);
    expect(err.join('\n')).toContain('missing columns: Input (w/ Cache Write)');
    await expect(stat(importFile())).rejects.toThrow();
    await expect(stat(join(home, 'state.json'))).rejects.toThrow();
  });

  it('reports an unreadable file', async () => {
    expect(await runImportCursor('nope.csv', { readFile: async () => Promise.reject(new Error('ENOENT')) })).toBe(1);
    expect(err.join('\n')).toContain('Could not read nope.csv');
  });
});

describe('Cursor adapter with imported rows', () => {
  const saved = process.env['TOKENGRAPH_HOME'];
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tg-cursor-cutoff-'));
    process.env['TOKENGRAPH_HOME'] = home;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
  });

  function imported(id: string, at: string, inputTokens: number): string {
    return JSON.stringify({ id, at, model: 'gpt-5', maxMode: false, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }

  it('counts imported rows only strictly before the earliest hook event, and sums them with the hook turns', async () => {
    await writeFile(
      join(home, 'cursor-events.jsonl'),
      [eventLine('2026-05-02T12:00:00.000Z', 'late'), eventLine('2026-05-02T10:00:00.000Z', 'early')].join('\n'),
    );
    await writeFile(
      join(home, 'cursor-import.jsonl'),
      [
        imported('a', '2026-05-02T09:59:59.999Z', 1),
        imported('b', '2026-05-02T10:00:00.000Z', 10),
        imported('c', '2026-05-02T10:00:00.001Z', 100),
        imported('d', '2026-05-01T00:00:00.000Z', 1000),
        'garbage',
      ].join('\n'),
    );
    const result = await createCursorAdapter({ timeZone: 'UTC' }).collect(new Date(0));
    const byModel = (model: string) => result.usage.filter((entry) => entry.model === model).reduce((sum, entry) => sum + entry.counts.inputTokens, 0);
    expect(byModel('gpt-5')).toBe(1 + 1000);
    expect(byModel('composer-2.5')).toBe(200);
    expect(result.requestCount).toBe(4);
  });

  it('counts every imported row when the hook never ran, is detected from the import file alone, and honours since', async () => {
    const adapter = createCursorAdapter({ timeZone: 'UTC' });
    expect(await adapter.detect()).toBe(false);
    await writeFile(join(home, 'cursor-import.jsonl'), [imported('a', '2026-05-02T10:00:00.000Z', 3), imported('b', '2026-04-01T10:00:00.000Z', 4)].join('\n'));
    expect(await adapter.detect()).toBe(true);
    expect((await adapter.collect(new Date('2026-01-01'))).usage.reduce((sum, entry) => sum + entry.counts.inputTokens, 0)).toBe(7);
    expect((await adapter.collect(new Date('2026-05-01'))).usage.reduce((sum, entry) => sum + entry.counts.inputTokens, 0)).toBe(3);
  });

  it('applies the cutoff at every collect, so a later hook install hides rows it now overlaps', async () => {
    const adapter = createCursorAdapter({ timeZone: 'UTC' });
    await writeFile(join(home, 'cursor-import.jsonl'), imported('a', '2026-05-02T10:00:00.000Z', 3));
    expect((await adapter.collect(new Date(0))).usage).toHaveLength(1);
    await writeFile(join(home, 'cursor-events.jsonl'), eventLine('2026-05-01T00:00:00.000Z'));
    expect((await adapter.collect(new Date(0))).usage.map((entry) => entry.model)).toEqual(['composer-2.5']);
  });
});
