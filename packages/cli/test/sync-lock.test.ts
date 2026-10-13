import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncLockPath } from '../src/paths.js';
import { acquireSyncLock, STALE_LOCK_MS } from '../src/sync-lock.js';

describe('sync lock', () => {
  const saved = process.env['TOKENGRAPH_HOME'];
  let root: string;
  const NOW = 1_000_000_000_000;
  const deps = (alive: boolean) => ({ now: () => NOW, isPidAlive: () => alive });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-lock-'));
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
    await rm(root, { recursive: true, force: true });
  });

  it('acquires, records pid and start time, and releases', async () => {
    const lock = await acquireSyncLock(deps(true));
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(await readFile(syncLockPath(), 'utf8'))).toEqual({ pid: process.pid, startedAt: NOW });
    if (lock.acquired) await lock.release();
    await expect(stat(syncLockPath())).rejects.toThrow();
  });

  it('reports the holder when a live, fresh lock exists', async () => {
    const first = await acquireSyncLock(deps(true));
    const second = await acquireSyncLock(deps(true));
    expect(second).toEqual({ acquired: false, pid: process.pid });
    if (first.acquired) await first.release();
  });

  it('reclaims a lock whose pid is dead', async () => {
    await acquireSyncLock(deps(true));
    const again = await acquireSyncLock(deps(false));
    expect(again.acquired).toBe(true);
  });

  it('reclaims a lock older than the stale age even if the pid is alive', async () => {
    await acquireSyncLock(deps(true));
    const later = { now: () => NOW + STALE_LOCK_MS + 1, isPidAlive: () => true };
    expect((await acquireSyncLock(later)).acquired).toBe(true);
  });

  it('does not remove a lock another sync has taken over', async () => {
    const lock = await acquireSyncLock(deps(true));
    const takeover = JSON.stringify({ pid: process.pid + 1, startedAt: NOW });
    await writeFile(syncLockPath(), takeover);
    if (lock.acquired) await lock.release();
    expect(await readFile(syncLockPath(), 'utf8')).toBe(takeover);
  });

  it('reclaims an unparsable lock file', async () => {
    await acquireSyncLock(deps(true));
    await writeFile(syncLockPath(), 'not json');
    expect((await acquireSyncLock(deps(true))).acquired).toBe(true);
    await writeFile(syncLockPath(), '{"pid":"x"}');
    expect((await acquireSyncLock(deps(true))).acquired).toBe(true);
  });
});
