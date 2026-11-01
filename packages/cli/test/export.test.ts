import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DailyModelUsage, SplitTokenCounts } from '@tokengraph/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseExportArgs, runExport } from '../src/commands/export.js';
import { emptyLedger, mergeHours, mergeProjectRoots, mergeProjects, mergeUsage, writeLedger } from '../src/ledger.js';
import { ledgerPath, machinesCachePath } from '../src/paths.js';
import { normaliseFolder } from '../src/project-roots.js';
import { writeMachinesCache } from '../src/publish/machines-cache.js';

const HEADER =
  'date,source,model,pricing_tier,input_tokens,output_tokens,cache_write_tokens,cache_write_5m_tokens,cache_write_1h_tokens,cache_read_tokens,weighted_tokens,estimated_cost_usd';

function counts(input: number, split: [number, number] | null = [0, 0]): SplitTokenCounts {
  return {
    inputTokens: input,
    outputTokens: 10,
    cacheCreationTokens: 20,
    cacheReadTokens: 100,
    cacheCreation5mTokens: split ? split[0] : null,
    cacheCreation1hTokens: split ? split[1] : null,
  };
}

function usage(date: string, model: string, c: SplitTokenCounts, pricingTier: DailyModelUsage['pricingTier'] = 'standard'): DailyModelUsage {
  return { date, model, pricingTier, counts: c };
}

describe('tokengraph export', () => {
  let out: string;
  let err: string;
  let dir: string;
  beforeEach(async () => {
    out = '';
    err = '';
    dir = await mkdtemp(join(tmpdir(), 'tokengraph-export-'));
    await rm(machinesCachePath(), { force: true });
    await rm(ledgerPath(), { force: true });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      err += `${String(line)}\n`;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    let ledger = emptyLedger();
    ledger = mergeUsage(ledger, 'codex-cli', [usage('2026-10-02', 'mystery-model-1', counts(5, null))]);
    ledger = mergeUsage(ledger, 'claude-code', [
      usage('2026-10-02', 'claude-opus-5-5', counts(1000, [15, 5])),
      usage('2026-10-01', 'weird,"model"', counts(7, [20, 0])),
      usage('2026-10-01', 'claude-opus-5-5', counts(1, [20, 0]), 'fast'),
      usage('2026-10-01', 'claude-opus-5-5', counts(2, [20, 0])),
    ]);
    await mkdir(dirname(ledgerPath()), { recursive: true });
    await writeLedger(ledgerPath(), ledger);
  }

  it('writes a sorted CSV with quoting, empty unknowns and rounded cost', async () => {
    await seed();
    expect(await runExport({ format: 'csv' })).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines.at(-1)).toBe('');
    expect(out).not.toContain('\r');
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    const rows = lines.slice(1, -1);
    expect(rows.map((r) => r.split(',').slice(0, 2).join(','))).toEqual([
      '2026-10-01,claude-code',
      '2026-10-01,claude-code',
      '2026-10-01,claude-code',
      '2026-10-02,claude-code',
      '2026-10-02,codex-cli',
    ]);
    // Sorted by model within the day: the quoted one sorts before claude-opus ("w" > "c", so after).
    expect(rows[2]).toContain('"weird,""model"""');
    // Standard tier before fast.
    expect(rows[0]).toContain(',claude-opus-5-5,standard,');
    expect(rows[1]).toContain(',claude-opus-5-5,fast,');
    // Null split and unpriced model: empty fields, never 0.
    expect(rows[4]).toBe('2026-10-02,codex-cli,mystery-model-1,standard,5,10,20,,,100,45,');
    // Weighted = 2 + 10 + 20 + 0.1 * 100.
    expect(rows[0]!.split(',')[10]).toBe('42');
    const cost = rows[0]!.split(',')[11]!;
    expect(cost).toMatch(/^\d+(\.\d{1,6})?$/);
  });

  it('writes JSON with a schema, scope and null for unknowns', async () => {
    await seed();
    expect(await runExport({ format: 'json' })).toBe(0);
    expect(out.endsWith('}\n')).toBe(true);
    expect(out).toContain('\n  "schema": 1,');
    const parsed = JSON.parse(out) as { schema: number; scope: string; rows: Record<string, unknown>[] };
    expect(parsed.scope).toBe('this-machine');
    expect(parsed.rows).toHaveLength(5);
    expect(Object.keys(parsed.rows[0]!)).toEqual([
      'date', 'source', 'model', 'pricingTier', 'inputTokens', 'outputTokens', 'cacheWriteTokens',
      'cacheWrite5mTokens', 'cacheWrite1hTokens', 'cacheReadTokens', 'weightedTokens', 'estimatedCostUsd',
    ]);
    const codex = parsed.rows[4]!;
    expect(codex).toMatchObject({ source: 'codex-cli', model: 'mystery-model-1', cacheWrite5mTokens: null, cacheWrite1hTokens: null, estimatedCostUsd: null });
    expect(typeof parsed.rows[0]!['estimatedCostUsd']).toBe('number');
  });

  it('gives the same bytes twice', async () => {
    await seed();
    await runExport({ format: 'json' });
    const first = out;
    out = '';
    await runExport({ format: 'json' });
    expect(out).toBe(first);
  });

  it('keeps only days on or after --since', async () => {
    await seed();
    await runExport({ format: 'csv', since: '2026-10-02' });
    expect(out.split('\n').slice(1, -1).map((r) => r.slice(0, 10))).toEqual(['2026-10-02', '2026-10-02']);
  });

  it('adds other machines per day, source, model and tier with --all-machines', async () => {
    await seed();
    await writeMachinesCache([
      {
        schema: 1,
        machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40',
        label: 'darwin-3f2a1c',
        fingerprint: 'fp',
        cliVersion: '1.0.0',
        updatedAt: '2026-10-12T08:00:00.000Z',
        sources: mergeUsage(emptyLedger(), 'claude-code', [
          usage('2026-10-02', 'claude-opus-5-5', counts(500, [1, 1])),
          usage('2026-10-03', 'claude-opus-5-5', counts(3, [1, 1])),
        ]).sources,
      },
    ]);
    await runExport({ format: 'json', allMachines: true });
    const parsed = JSON.parse(out) as { scope: string; rows: { date: string; source: string; inputTokens: number }[] };
    expect(parsed.scope).toBe('all-machines');
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.rows.find((r) => r.date === '2026-10-02' && r.source === 'claude-code')!.inputTokens).toBe(1500);
    expect(parsed.rows.at(-1)).toMatchObject({ date: '2026-10-03', inputTokens: 3 });
    out = '';
    await runExport({ format: 'json' });
    expect(JSON.parse(out).rows).toHaveLength(5);
  });

  it('writes to --out and prints only a confirmation', async () => {
    await seed();
    const file = join(dir, 'usage.csv');
    expect(await runExport({ format: 'csv', out: file })).toBe(0);
    expect(out).toBe(`Wrote 5 rows to ${file}.\n`);
    expect((await readFile(file, 'utf8')).startsWith(HEADER)).toBe(true);
  });

  it('creates the folder --out names when it does not exist yet', async () => {
    await seed();
    const file = join(dir, 'new', 'deeper', 'usage.csv');
    expect(await runExport({ format: 'csv', out: file })).toBe(0);
    expect((await readFile(file, 'utf8')).startsWith(HEADER)).toBe(true);
  });

  it('gives a header-only CSV and empty rows for an empty ledger', async () => {
    await runExport({ format: 'csv' });
    expect(out).toBe(`${HEADER}\n`);
    out = '';
    await runExport({ format: 'json' });
    expect(JSON.parse(out)).toEqual({ schema: 1, scope: 'this-machine', rows: [] });
  });

  it('rejects a bad format and a bad --since', () => {
    expect(parseExportArgs({ format: 'xml' })).toBe('--format must be csv or json.');
    expect(parseExportArgs({ since: '2026-13-01' })).toBe('--since must be a date as YYYY-MM-DD.');
    expect(parseExportArgs({ since: 'yesterday' })).toBe('--since must be a date as YYYY-MM-DD.');
    expect(parseExportArgs({})).toEqual({ format: 'csv', since: undefined, out: undefined, allMachines: false });
  });

  describe('--hours', () => {
    async function seedHours(): Promise<void> {
      let ledger = emptyLedger();
      ledger = mergeHours(ledger, 'claude-code', [
        { date: '2026-10-01', hour: 22, weighted: 500 },
        { date: '2026-10-02', hour: 9, weighted: 70 },
      ]);
      ledger = mergeHours(ledger, 'codex-cli', [{ date: '2026-10-02', hour: 9, weighted: 30 }]);
      await mkdir(dirname(ledgerPath()), { recursive: true });
      await writeLedger(ledgerPath(), ledger);
    }

    it('writes date, hour, source and weighted tokens as CSV', async () => {
      await seedHours();
      expect(await runExport({ format: 'csv', hours: true })).toBe(0);
      expect(out).toBe('date,hour,source,weighted_tokens\n2026-10-01,22,claude-code,500\n2026-10-02,9,claude-code,70\n2026-10-02,9,codex-cli,30\n');
    });

    it('writes JSON for this machine only and respects --since', async () => {
      await seedHours();
      expect(await runExport({ format: 'json', hours: true, since: '2026-10-02' })).toBe(0);
      expect(JSON.parse(out)).toEqual({
        schema: 1,
        scope: 'this-machine',
        rows: [
          { date: '2026-10-02', hour: 9, source: 'claude-code', weightedTokens: 70 },
          { date: '2026-10-02', hour: 9, source: 'codex-cli', weightedTokens: 30 },
        ],
      });
    });

    it('gives only a header without hour data, and refuses --all-machines', async () => {
      expect(await runExport({ format: 'csv', hours: true })).toBe(0);
      expect(out).toBe('date,hour,source,weighted_tokens\n');
      expect(parseExportArgs({ hours: true, 'all-machines': true })).toMatch(/this machine only/);
      expect(parseExportArgs({ hours: true })).toMatchObject({ hours: true });
    });
  });

  describe('--projects', () => {
    const folderRow = (folder: string, input: number) => ({ ...usage('2026-07-01', 'claude-opus-4-8', counts(input)), folder });
    const write = async () => {
      const base = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-07-01', 'claude-opus-4-8', counts(1000))]);
      const home = normaliseFolder(homedir());
      await writeLedger(ledgerPath(), mergeProjectRoots(mergeProjects(base, 'claude-code', [folderRow(`${home}/secret-place/app`, 600)]), { [`${home}/secret-place/app`]: `${home}/secret-place/app` }));
    };

    it('adds a project column with the name, never the path', async () => {
      await write();
      expect(await runExport({ format: 'csv', projects: true })).toBe(0);
      const [header, ...lines] = out.trim().split('\n');
      expect(header).toBe(HEADER.replace('date,', 'date,project,'));
      expect(lines.map((line) => line.split(',')[1])).toEqual(['app', 'Not assigned']);
      expect(out).not.toContain('secret-place');
    });

    it('never lets a project name run as a spreadsheet formula', async () => {
      const home = normaliseFolder(homedir());
      const folder = `${home}/=HYPERLINK("x")`;
      const base = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-07-01', 'claude-opus-4-8', counts(1000))]);
      await writeLedger(ledgerPath(), mergeProjects(base, 'claude-code', [folderRow(folder, 600), folderRow(`${home}/-rm`, 100), folderRow(`${home}/+x`, 100), folderRow(`${home}/@y`, 100)]));
      await runExport({ format: 'csv', projects: true });
      const cells = out.trim().split('\n').slice(1).map((line) => line.split(',')[1]!.replace(/^"|"$/g, ''));
      expect(cells.filter((cell) => /^[=+\-@]/.test(cell))).toEqual([]);
      expect(cells).toContain("'-rm");
      expect(cells).toContain("'+x");
      expect(cells).toContain("'@y");
      out = '';
      await runExport({ format: 'json', projects: true });
      expect((JSON.parse(out) as { rows: { project: string }[] }).rows.map((row) => row.project)).toContain('-rm');
    });

    it('holds the same rows in JSON', async () => {
      await write();
      await runExport({ format: 'json', projects: true });
      const parsed = JSON.parse(out) as { rows: { project: string; inputTokens: number }[] };
      expect(parsed.rows.map((row) => [row.project, row.inputTokens])).toEqual([['app', 600], ['Not assigned', 400]]);
    });

    it('sums to the plain export', async () => {
      await write();
      await runExport({ format: 'json', projects: true });
      const split = (JSON.parse(out) as { rows: { weightedTokens: number; estimatedCostUsd: number }[] }).rows;
      out = '';
      await runExport({ format: 'json' });
      const [plain] = (JSON.parse(out) as { rows: { weightedTokens: number; estimatedCostUsd: number }[] }).rows;
      expect(split.reduce((sum, row) => sum + row.weightedTokens, 0)).toBeCloseTo(plain!.weightedTokens);
      expect(split.reduce((sum, row) => sum + row.estimatedCostUsd, 0)).toBeCloseTo(plain!.estimatedCostUsd, 4);
    });

    it('leaves the plain export byte-identical', async () => {
      await write();
      await runExport({ format: 'csv' });
      expect(out.split('\n')[0]).toBe(HEADER);
      expect(out).not.toContain('Not assigned');
    });

    it('cannot be combined with --all-machines or --hours', () => {
      expect(parseExportArgs({ projects: true, 'all-machines': true })).toContain('--projects');
      expect(parseExportArgs({ projects: true, hours: true })).toContain('--projects');
    });
  });
});
