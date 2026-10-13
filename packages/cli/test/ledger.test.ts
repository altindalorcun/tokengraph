import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DailyModelUsage, PricingTier } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import {
  allLedgerUsage,
  emptyLedger,
  ledgerToUsage,
  mergeUsage,
  parseLedger,
  readLedger,
  writeLedger,
} from '../src/ledger.js';

function usage(
  date: string,
  model: string,
  counts: Partial<DailyModelUsage['counts']> = {},
  pricingTier: PricingTier = 'standard',
): DailyModelUsage {
  return {
    date,
    model,
    pricingTier,
    counts: {
      inputTokens: counts.inputTokens ?? 0,
      outputTokens: counts.outputTokens ?? 0,
      cacheCreationTokens: counts.cacheCreationTokens ?? 0,
      cacheReadTokens: counts.cacheReadTokens ?? 0,
      cacheCreation5mTokens: counts.cacheCreation5mTokens === undefined ? 0 : counts.cacheCreation5mTokens,
      cacheCreation1hTokens: counts.cacheCreation1hTokens === undefined ? 0 : counts.cacheCreation1hTokens,
    },
  };
}

describe('mergeUsage', () => {
  it('records usage that is not yet in the ledger', () => {
    const merged = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 100 })]);
    expect(merged.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!.outputTokens).toBe(100);
  });

  it('keeps the higher value when Claude Code has pruned transcripts', () => {
    // The day was fully collected once, then part of it was deleted from disk.
    const full = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 5000 })]);
    const afterPruning = mergeUsage(full, 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 1200 })]);
    expect(afterPruning.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!.outputTokens).toBe(5000);
  });

  it('grows a day that is still in progress', () => {
    const morning = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 100 })]);
    const evening = mergeUsage(morning, 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 900 })]);
    expect(evening.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!.outputTokens).toBe(900);
  });

  it('takes the maximum of each field independently', () => {
    const first = mergeUsage(emptyLedger(), 'claude-code', [
      usage('2026-09-10', 'sonnet', { outputTokens: 900, cacheReadTokens: 10 }),
    ]);
    const second = mergeUsage(first, 'claude-code', [
      usage('2026-09-10', 'sonnet', { outputTokens: 100, cacheReadTokens: 8000 }),
    ]);
    expect(second.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!).toMatchObject({
      outputTokens: 900,
      cacheReadTokens: 8000,
    });
  });

  it('keeps models and days apart', () => {
    const merged = mergeUsage(emptyLedger(), 'claude-code', [
      usage('2026-09-10', 'sonnet', { outputTokens: 1 }),
      usage('2026-09-10', 'opus', { outputTokens: 2 }),
      usage('2026-09-11', 'sonnet', { outputTokens: 3 }),
    ]);
    expect(Object.keys(merged.sources['claude-code']!)).toEqual(['2026-09-10', '2026-09-11']);
    expect(Object.keys(merged.sources['claude-code']!['2026-09-10']!)).toEqual(['sonnet', 'opus']);
  });

  it('does not mutate the ledger it was given', () => {
    const original = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 10 })]);
    mergeUsage(original, 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 99 })]);
    expect(original.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!.outputTokens).toBe(10);
  });
});

describe('ledgerToUsage', () => {
  it('returns entries sorted by day then model', () => {
    const ledger = mergeUsage(emptyLedger(), 'claude-code', [
      usage('2026-09-11', 'sonnet'),
      usage('2026-09-10', 'opus'),
      usage('2026-09-10', 'haiku'),
    ]);
    expect(ledgerToUsage(ledger, 'claude-code').map((u) => `${u.date} ${u.model}`)).toEqual([
      '2026-09-10 haiku',
      '2026-09-10 opus',
      '2026-09-11 sonnet',
    ]);
  });

  it('can restrict the window', () => {
    const ledger = mergeUsage(emptyLedger(), 'claude-code', [
      usage('2026-01-01', 'sonnet'),
      usage('2026-09-10', 'sonnet'),
    ]);
    expect(ledgerToUsage(ledger, 'claude-code', '2026-06-01')).toHaveLength(1);
  });
});

describe('parseLedger', () => {
  it('rejects an unknown version rather than guessing', () => {
    expect(parseLedger({ version: 99, days: { '2026-09-10': {} } })).toEqual(emptyLedger());
  });

  it('drops malformed days and counts but keeps the good ones', () => {
    const parsed = parseLedger({
      version: 1,
      days: {
        'not-a-date': { sonnet: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 1, cacheReadTokens: 1 } },
        '2026-09-10': {
          broken: { inputTokens: -1, outputTokens: 1, cacheCreationTokens: 1, cacheReadTokens: 1 },
          sonnet: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
        },
      },
    });
    expect(Object.keys(parsed.sources['claude-code']!)).toEqual(['2026-09-10']);
    expect(Object.keys(parsed.sources['claude-code']!['2026-09-10']!)).toEqual(['sonnet']);
  });

  it('returns an empty ledger for junk', () => {
    expect(parseLedger(null)).toEqual(emptyLedger());
    expect(parseLedger('nope')).toEqual(emptyLedger());
  });

  it('migrates a v1 ledger to v3 with the cache-write split marked unknown, not zero', () => {
    // v1 never had the split fields at all — this is the exact shape a real v1 state.json holds.
    const parsed = parseLedger({
      version: 1,
      days: {
        '2026-09-10': { sonnet: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 } },
      },
    });
    expect(parsed.version).toBe(3);
    expect(parsed.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    });
  });

  it('self-heals a migrated-unknown split to a real value on the next sync', () => {
    const migrated = parseLedger({
      version: 1,
      days: { '2026-09-10': { sonnet: { inputTokens: 0, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 } } },
    });
    const resynced = mergeUsage(migrated, 'claude-code', [
      usage('2026-09-10', 'sonnet', { outputTokens: 100, cacheCreation5mTokens: 50, cacheCreation1hTokens: 0 }),
    ]);
    expect(resynced.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!.cacheCreation5mTokens).toBe(50);
  });

  it('keeps a pruned day unknown forever rather than fabricating zero', () => {
    const migrated = parseLedger({
      version: 1,
      days: { '2026-09-10': { sonnet: { inputTokens: 0, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 } } },
    });
    // The transcript for this day is gone, so a later sync has nothing new to merge in.
    expect(migrated.sources['claude-code']!['2026-09-10']!['sonnet']!.standard!.cacheCreation5mTokens).toBeNull();
  });
});

describe('ledger persistence', () => {
  it('round-trips through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-graph-'));
    const path = join(dir, 'state.json');
    const ledger = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-09-10', 'sonnet', { outputTokens: 42 })]);
    await writeLedger(path, ledger);
    expect(await readLedger(path)).toEqual(ledger);
  });

  it('starts fresh when the file is missing or corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-graph-'));
    expect(await readLedger(join(dir, 'absent.json'))).toEqual(emptyLedger());
    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, '{ this is not json');
    expect(await readLedger(corrupt)).toEqual(emptyLedger());
  });

  it('leaves no temporary file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-graph-'));
    const path = join(dir, 'state.json');
    await writeLedger(path, emptyLedger());
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('writes through a per-process temporary file so concurrent syncs cannot collide', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-tmp-'));
    const path = join(dir, 'state.json');
    await Promise.all([writeLedger(path, emptyLedger()), writeLedger(path, emptyLedger())]);
    expect(parseLedger(JSON.parse(await readFile(path, 'utf8')))).toEqual(emptyLedger());
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('ledger v3', () => {
  it('migrates a v2 ledger into the claude-code source at the standard tier', () => {
    const counts = {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      cacheCreation5mTokens: 3,
      cacheCreation1hTokens: 0,
    };
    const ledger = parseLedger({ version: 2, days: { '2026-09-10': { sonnet: counts } } });
    expect(ledger).toEqual({
      version: 3,
      sources: { 'claude-code': { '2026-09-10': { sonnet: { standard: counts } } } },
    });
  });

  it('keeps sources apart even for the same day and model name', () => {
    let ledger = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-09-10', 'shared', { outputTokens: 5 })]);
    ledger = mergeUsage(ledger, 'codex-cli', [usage('2026-09-10', 'shared', { outputTokens: 1 })]);
    expect(ledgerToUsage(ledger, 'claude-code')[0]!.counts.outputTokens).toBe(5);
    expect(ledgerToUsage(ledger, 'codex-cli')[0]!.counts.outputTokens).toBe(1);
    expect(allLedgerUsage(ledger)).toHaveLength(2);
  });

  it('keeps pricing tiers apart and max-merges each on its own', () => {
    let ledger = mergeUsage(emptyLedger(), 'codex-cli', [
      usage('2026-09-10', 'gpt-6-luna', { inputTokens: 10 }),
      usage('2026-09-10', 'gpt-6-luna', { inputTokens: 500 }, 'long-context'),
    ]);
    ledger = mergeUsage(ledger, 'codex-cli', [usage('2026-09-10', 'gpt-6-luna', { inputTokens: 3 }, 'long-context')]);
    expect(ledgerToUsage(ledger, 'codex-cli').map((u) => [u.pricingTier, u.counts.inputTokens])).toEqual([
      ['standard', 10],
      ['long-context', 500],
    ]);
  });

  it('keeps an unknown cache split as null through merge and a write/read round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'state.json');
    const ledger = mergeUsage(emptyLedger(), 'codex-cli', [
      usage('2026-09-10', 'gpt-6-luna', { inputTokens: 1, cacheCreation5mTokens: null, cacheCreation1hTokens: null }),
    ]);
    await writeLedger(path, ledger);
    const [entry] = ledgerToUsage(await readLedger(path), 'codex-cli');
    expect(entry!.counts.cacheCreation5mTokens).toBeNull();
    expect(entry!.counts.cacheCreation1hTokens).toBeNull();
  });

  it('drops unknown sources and tiers instead of failing the whole ledger', () => {
    const counts = {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    };
    const ledger = parseLedger({
      version: 3,
      sources: {
        'codex-cli': { '2026-09-10': { 'gpt-6-luna': { standard: counts, turbo: counts } } },
        'made-up': { '2026-09-10': { x: { standard: counts } } },
      },
    });
    expect(Object.keys(ledger.sources)).toEqual(['codex-cli']);
    expect(ledgerToUsage(ledger, 'codex-cli').map((u) => u.pricingTier)).toEqual(['standard']);
  });

  it('filters by date across every source', () => {
    let ledger = mergeUsage(emptyLedger(), 'claude-code', [usage('2026-09-01', 'a'), usage('2026-09-10', 'a')]);
    ledger = mergeUsage(ledger, 'codex-cli', [usage('2026-09-10', 'b')]);
    expect(allLedgerUsage(ledger, '2026-09-05').map((u) => u.date)).toEqual(['2026-09-10', '2026-09-10']);
  });
});
