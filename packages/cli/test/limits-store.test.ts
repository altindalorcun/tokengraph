import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LimitReading } from '@tokengraph/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeClaudeReading, readLimitsFile, storeClaudeReading } from '../src/limits/store.js';

function claude(readAt: string, windows: Record<string, number>, origin: LimitReading['origin'] = 'statusline'): LimitReading {
  return {
    source: 'claude-code',
    limitId: null,
    plan: null,
    origin,
    readAt,
    credits: null,
    windows: Object.entries(windows).map(([id, usedPercent]) => ({ id, minutes: id === 'five_hour' ? 300 : 10080, usedPercent, resetsAt: '2026-11-20T00:00:00.000Z' })),
  };
}

describe('readLimitsFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'limits-store-'));
  });

  it('reads a missing file as empty', async () => {
    expect(await readLimitsFile(join(dir, 'limits.json'))).toEqual({ schema: 1, claudeCode: null });
  });

  it('reads a file that is not ours as empty', async () => {
    const path = join(dir, 'limits.json');
    await writeFile(path, 'not json');
    expect(await readLimitsFile(path)).toEqual({ schema: 1, claudeCode: null });
    await writeFile(path, JSON.stringify({ schema: 1, claudeCode: { windows: 'x' } }));
    expect(await readLimitsFile(path)).toEqual({ schema: 1, claudeCode: null });
  });
});

describe('mergeClaudeReading', () => {
  it('keeps the newer window when an older limit hit arrives', () => {
    const stored = claude('2026-11-19T10:00:00Z', { five_hour: 40 });
    const hit = claude('2026-11-19T09:00:00Z', { five_hour: 100 }, 'limit-hit');
    expect(mergeClaudeReading(stored, hit)).toEqual(stored);
  });

  it('takes a newer window and keeps the windows only one side has', () => {
    const stored = claude('2026-11-19T10:00:00Z', { five_hour: 40, seven_day: 10 });
    const next = claude('2026-11-19T11:00:00Z', { seven_day: 12 }, 'limit-hit');
    const merged = mergeClaudeReading(stored, next);
    expect(merged.readAt).toBe('2026-11-19T11:00:00Z');
    expect(merged.origin).toBe('limit-hit');
    expect(Object.fromEntries(merged.windows.map((w) => [w.id, w.usedPercent]))).toEqual({ five_hour: 40, seven_day: 12 });
  });

  it('drops a window the newer reading lacks once it has reset, and keeps one still open', () => {
    const stored = claude('2026-11-19T10:00:00Z', { five_hour: 40, seven_day_opus: 100, seven_day: 5 });
    stored.windows.find((w) => w.id === 'seven_day_opus')!.resetsAt = '2026-11-19T10:30:00.000Z';
    const next = claude('2026-11-19T11:00:00Z', { five_hour: 41 });
    expect(mergeClaudeReading(stored, next).windows.map((w) => w.id).sort()).toEqual(['five_hour', 'seven_day']);
  });

  it('takes the next reading whole when nothing is stored', () => {
    const next = claude('2026-11-19T11:00:00Z', { five_hour: 1 });
    expect(mergeClaudeReading(null, next)).toEqual(next);
  });
});

describe('storeClaudeReading', () => {
  let path: string;
  beforeEach(async () => {
    path = join(await mkdtemp(join(tmpdir(), 'limits-store-')), 'limits.json');
  });

  it('writes a reading and reads it back', async () => {
    const reading = claude('2026-11-19T10:00:00Z', { five_hour: 40 });
    expect(await storeClaudeReading(reading, path)).toBe(true);
    expect((await readLimitsFile(path)).claudeCode).toEqual(reading);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('does not write when nothing changed', async () => {
    const reading = claude('2026-11-19T10:00:00Z', { five_hour: 40 });
    await storeClaudeReading(reading, path);
    const before = await readFile(path, 'utf8');
    const mtime = (await stat(path)).mtimeMs;
    expect(await storeClaudeReading(reading, path)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await stat(path)).mtimeMs).toBe(mtime);
  });

  it('leaves a whole file and no temp files after parallel writes', async () => {
    await Promise.all([
      storeClaudeReading(claude('2026-11-19T10:00:00Z', { five_hour: 40 }), path),
      storeClaudeReading(claude('2026-11-19T10:00:01Z', { five_hour: 41 }), path),
      storeClaudeReading(claude('2026-11-19T10:00:02Z', { seven_day: 5 }), path),
    ]);
    const file = await readLimitsFile(path);
    expect(file.claudeCode).not.toBeNull();
    expect((await readdir(join(path, '..'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('swallows errors and reports nothing written', async () => {
    const blocker = join(path, '..', 'blocker');
    await writeFile(blocker, '');
    const reading = claude('2026-11-19T10:00:00Z', { five_hour: 40 });
    expect(await storeClaudeReading(reading, join(blocker, 'limits.json'))).toBe(false);
  });
});
