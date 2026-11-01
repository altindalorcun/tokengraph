import { describe, expect, it } from 'vitest';
import type { ProjectUsage } from '@tokengraph/core';
import { collectLocal } from '../src/collect-local.js';
import {
  emptyLedger,
  LEDGER_VERSION,
  mergeLedgerProjects,
  mergeProjectRoots,
  mergeProjects,
  parseLedger,
  projectUsageRows,
} from '../src/ledger.js';

const counts = (inputTokens: number, outputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
});
const row = (folder: string, input: number, output = 0): ProjectUsage => ({
  folder,
  date: '2026-10-01',
  model: 'claude-opus-4-8',
  pricingTier: 'standard',
  counts: counts(input, output),
});

describe('mergeProjects', () => {
  it('keeps the higher count per folder, date, model and tier', () => {
    const first = mergeProjects(emptyLedger(), 'claude-code', [row('/w/a', 100, 5), row('/w/b', 7)]);
    const second = mergeProjects(first, 'claude-code', [row('/w/a', 40, 9)]);
    const rows = projectUsageRows(second, 'claude-code');
    expect(rows.find((r) => r.folder === '/w/a')?.counts).toMatchObject({ inputTokens: 100, outputTokens: 9 });
    expect(rows.find((r) => r.folder === '/w/b')?.counts).toMatchObject({ inputTokens: 7 });
  });

  it('leaves the ledger untouched for an adapter with no folders', () => {
    const ledger = emptyLedger();
    expect(mergeProjects(ledger, 'claude-code', undefined)).toBe(ledger);
    expect(mergeProjects(ledger, 'claude-code', [])).toBe(ledger);
  });

  it('touches nothing the graph reads', () => {
    expect(mergeProjects(emptyLedger(), 'claude-code', [row('/w/a', 1)]).sources).toEqual({});
  });
});

describe('mergeLedgerProjects', () => {
  it('keeps what a concurrent sync wrote and the newer root of each folder', () => {
    const disk = mergeProjectRoots(mergeProjects(emptyLedger(), 'codex-cli', [row('/w/x', 50)]), { '/w/x': '/w' });
    const mine = mergeProjectRoots(mergeProjects(emptyLedger(), 'claude-code', [row('/w/a', 3)]), { '/w/a': '/w/a' });
    const merged = mergeLedgerProjects(disk, mine);
    expect(projectUsageRows(merged, 'codex-cli')).toHaveLength(1);
    expect(projectUsageRows(merged, 'claude-code')).toHaveLength(1);
    expect(merged.projects?.roots).toEqual({ '/w/x': '/w', '/w/a': '/w/a' });
  });

  it('is a no-op without project data', () => {
    const ledger = emptyLedger();
    expect(mergeLedgerProjects(ledger, emptyLedger())).toBe(ledger);
  });
});

describe('parseLedger with projects', () => {
  const stored = mergeProjectRoots(mergeProjects(emptyLedger(), 'claude-code', [row('/w/a', 100)]), { '/w/a': '/w' });

  it('round-trips a valid block', () => {
    expect(parseLedger(JSON.parse(JSON.stringify(stored))).projects).toEqual(stored.projects);
  });

  it('drops prototype keys, non-strings and over-long folders and keeps the rest', () => {
    const days = stored.projects!.usage['claude-code']!['/w/a'];
    const raw = JSON.parse(
      `{"version":${LEDGER_VERSION},"sources":{},"projects":{"usage":{"claude-code":{"__proto__":{},"constructor":${JSON.stringify(days)},"/w/a":${JSON.stringify(days)}}},"roots":{"__proto__":"/x","/w/a":"/w","/w/b":7}}}`,
    ) as unknown;
    const long = '/'.padEnd(1025, 'a');
    (raw as { projects: { usage: { 'claude-code': Record<string, unknown> } } }).projects.usage['claude-code'][long] = days;
    const parsed = parseLedger(raw).projects!;
    expect(Object.keys(parsed.usage['claude-code']!)).toEqual(['/w/a']);
    expect(Object.keys(parsed.roots)).toEqual(['/w/a']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps only absolute folders, so a name like toString can never meet an inherited property', () => {
    const days = stored.projects!.usage['claude-code']!['/w/a'];
    const parsed = parseLedger({ version: LEDGER_VERSION, sources: {}, projects: { usage: { 'claude-code': { toString: days, 'relative/path': days, 'C:/w': days, '/w/a': days } }, roots: { valueOf: '/x' } } }).projects!;
    expect(Object.keys(parsed.usage['claude-code']!)).toEqual(['C:/w', '/w/a']);
    expect(parsed.roots).toEqual({});
    expect(mergeProjects(emptyLedger(), 'claude-code', [row('toString', 5)]).projects).toBeUndefined();
  });

  it('a damaged block leaves sources and hours intact', () => {
    const base = { version: LEDGER_VERSION, sources: { 'claude-code': { '2026-10-01': { m: { standard: counts(1) } } } }, hours: { 'claude-code': { '2026-10-01': { '9': 4 } } } };
    for (const projects of [7, 'x', null, [], { usage: 3 }, { usage: { nope: {} }, roots: 1 }]) {
      const parsed = parseLedger({ ...base, projects });
      expect(parsed.projects).toBeUndefined();
      expect(parsed.sources['claude-code']).toBeDefined();
      expect(parsed.hours?.['claude-code']).toBeDefined();
    }
  });
});

describe('collectLocal', () => {
  it('merges what an adapter reports per folder', async () => {
    const { ledger } = await collectLocal(emptyLedger(), new Date('2026-09-01'), {
      adapters: [
        {
          name: 'claude-code',
          detect: async () => true,
          collect: async () => ({ source: 'claude-code', usage: [], requestCount: 1, projects: [row('/nowhere/a', 10)] }),
        },
      ],
    });
    expect(projectUsageRows(ledger, 'claude-code')).toHaveLength(1);
  });
});
