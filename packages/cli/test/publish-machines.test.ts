import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeUsage, type Ledger } from '../src/ledger.js';
import {
  activeDayCount,
  combinedUsage,
  isMachineFileName,
  machineFileName,
  machineLabel,
  maxMergeLedgers,
  parseMachineFile,
  resolveMachineId,
  serializeMachineFile,
  sourcesDigest,
  type MachineFile,
} from '../src/publish/machines.js';
import { readLastPublish, readMachinesCache, writeMachinesCache } from '../src/publish/machines-cache.js';

const A = '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40';
const B = '11111111-2222-4333-8444-555555555555';
const counts = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: null, cacheCreation1hTokens: null });

function ledgerWith(date: string, input: number): Ledger {
  return mergeUsage(emptyLedger(), 'claude-code', [{ date, model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(input) }]);
}

function file(machineId: string, ledger: Ledger, fingerprint = 'fp'): MachineFile {
  return { schema: 1, machineId, label: machineLabel('darwin', machineId), fingerprint, cliVersion: '0.1.0', updatedAt: '2026-10-13T10:00:00.000Z', sources: ledger.sources };
}

describe('machine file names', () => {
  it('round-trip', () => {
    expect(machineFileName(A)).toBe(`machine-${A}.json`);
    expect(isMachineFileName(machineFileName(A))).toBe(true);
    expect(isMachineFileName('tokengraph-data.md')).toBe(false);
    expect(machineLabel('darwin', A)).toBe('darwin-3f2a1c');
  });
});

describe('parse / serialize', () => {
  it('round-trips and rejects junk', () => {
    const original = file(A, ledgerWith('2026-10-01', 5));
    expect(parseMachineFile(serializeMachineFile(original))).toEqual(original);
    expect(parseMachineFile('not json')).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...original, schema: 2 }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...original, machineId: 'x' }))).toBeNull();
  });
});

describe('sourcesDigest', () => {
  it('ignores key order', () => {
    const one = mergeUsage(ledgerWith('2026-10-01', 5), 'codex', [{ date: '2026-10-02', model: 'gpt-5.5', pricingTier: 'standard', counts: counts(1) }]);
    const two = mergeUsage(mergeUsage(emptyLedger(), 'codex', [{ date: '2026-10-02', model: 'gpt-5.5', pricingTier: 'standard', counts: counts(1) }]), 'claude-code', [
      { date: '2026-10-01', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(5) },
    ]);
    expect(sourcesDigest(one.sources)).toBe(sourcesDigest(two.sources));
    expect(sourcesDigest(one.sources)).not.toBe(sourcesDigest(ledgerWith('2026-10-01', 6).sources));
  });
});

describe('maxMergeLedgers', () => {
  it('takes the larger count and restores missing days, never shrinking', () => {
    const local = ledgerWith('2026-10-02', 10);
    const remote = mergeUsage(ledgerWith('2026-10-02', 7), 'claude-code', [{ date: '2026-09-01', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(3) }]);
    const merged = maxMergeLedgers(local, remote.sources);
    expect(merged.sources['claude-code']!['2026-10-02']!['claude-opus-5-5']!.standard!.inputTokens).toBe(10);
    expect(merged.sources['claude-code']!['2026-09-01']!['claude-opus-5-5']!.standard!.inputTokens).toBe(3);
    expect(activeDayCount(merged.sources)).toBe(2);
  });
});

describe('combinedUsage', () => {
  it('sums other machines and never the local machine with itself', () => {
    const local = ledgerWith('2026-10-01', 10);
    const usage = combinedUsage(local, [file(B, ledgerWith('2026-10-01', 4))]);
    expect(usage.reduce((sum, entry) => sum + entry.counts.inputTokens, 0)).toBe(14);
  });

  it('applies the since date', () => {
    expect(combinedUsage(ledgerWith('2025-01-01', 10), [], '2026-01-01')).toEqual([]);
  });
});

describe('resolveMachineId', () => {
  const files = [file(B, ledgerWith('2026-10-01', 1), 'mine')];

  it('keeps a configured id', () => {
    expect(resolveMachineId({ configured: A, files, fingerprint: 'mine', newId: () => 'unused' })).toEqual({ machineId: A, adopted: null });
  });

  it('adopts the file with this machine fingerprint after a reinstall', () => {
    expect(resolveMachineId({ files, fingerprint: 'mine', newId: () => 'unused' })).toEqual({ machineId: B, adopted: files[0] });
  });

  it('creates a new id otherwise', () => {
    expect(resolveMachineId({ files, fingerprint: 'other', newId: () => A })).toEqual({ machineId: A, adopted: null });
  });
});

describe('machines cache', () => {
  it('round-trips and tolerates a missing file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tg-cache-')), 'machines.json');
    expect(await readMachinesCache(path)).toEqual([]);
    const files = [file(B, ledgerWith('2026-10-01', 1))];
    await writeMachinesCache(files, path);
    expect(await readMachinesCache(path)).toEqual(files);
  });

  it('remembers when the last publish happened, and old cache files still read', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tg-cache-')), 'machines.json');
    expect(await readLastPublish(path)).toBeNull();
    const files = [file(B, ledgerWith('2026-10-01', 1))];
    await writeMachinesCache(files, path, '2026-10-13T10:00:00.000Z');
    expect(await readLastPublish(path)).toBe('2026-10-13T10:00:00.000Z');
    expect(await readMachinesCache(path)).toEqual(files);
    await writeFile(path, JSON.stringify({ schema: 1, files: [] }));
    expect(await readLastPublish(path)).toBeNull();
  });
});
