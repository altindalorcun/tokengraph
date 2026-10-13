import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { configHome, syncLockPath } from './paths.js';

/** A lock older than this is treated as stale even if its pid is alive (pid reuse, hung process). */
export const STALE_LOCK_MS = 10 * 60 * 1000;

export interface LockDeps {
  now: () => number;
  isPidAlive: (pid: number) => boolean;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const DEFAULT_DEPS: LockDeps = { now: () => Date.now(), isPidAlive };

export type LockResult = { acquired: true; release: () => Promise<void> } | { acquired: false; pid: number | null };

interface LockContents {
  pid: number;
  startedAt: number;
}

function parseLock(raw: string): LockContents | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { pid, startedAt } = value as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

async function tryCreate(path: string, deps: LockDeps): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: deps.now() }));
  } finally {
    await handle.close();
  }
  return true;
}

/** Take the exclusive sync lock, reclaiming it if the holder is dead, too old, or the file is garbage. */
export async function acquireSyncLock(partial: Partial<LockDeps> = {}): Promise<LockResult> {
  const deps = { ...DEFAULT_DEPS, ...partial };
  const path = syncLockPath();
  await mkdir(configHome(), { recursive: true, mode: 0o700 });

  // Only remove the lock while it is still ours: after a stale-age reclaim another sync owns the file.
  const release = async (): Promise<void> => {
    try {
      if (parseLock(await readFile(path, 'utf8'))?.pid !== process.pid) return;
      await unlink(path);
    } catch {
      // Already gone.
    }
  };

  if (await tryCreate(path, deps)) return { acquired: true, release };

  let holder: LockContents | null = null;
  try {
    holder = parseLock(await readFile(path, 'utf8'));
  } catch (error) {
    // Vanished between our attempt and the read: the holder just finished, so try once more.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return (await tryCreate(path, deps)) ? { acquired: true, release } : { acquired: false, pid: null };
    }
    throw error;
  }

  const stale = holder === null || !deps.isPidAlive(holder.pid) || deps.now() - holder.startedAt > STALE_LOCK_MS;
  if (!stale && holder) return { acquired: false, pid: holder.pid };

  // Reclaim: unlink then retry once. If another process wins the retry, treat the lock as held.
  try {
    await unlink(path);
  } catch {
    // Someone else reclaimed it first; the retry below decides.
  }
  if (await tryCreate(path, deps)) return { acquired: true, release };
  return { acquired: false, pid: null };
}
