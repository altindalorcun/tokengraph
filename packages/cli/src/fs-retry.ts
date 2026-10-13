import { rename as fsRename, unlink } from 'node:fs/promises';

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const MAX_ATTEMPTS = 10;
const BACKOFF_MS_PER_ATTEMPT = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `rename` onto an existing path, retrying on Windows' transient sharing violations.
 *
 * Windows can refuse a rename onto a file that another process (or another rename in this
 * same process) currently has open for reading or writing, surfacing as EPERM, EACCES or
 * EBUSY even though nothing is actually wrong — the file is simply momentarily locked. POSIX
 * has no such restriction, so this only ever retries there in practice, but the logic runs on
 * every OS so it is exercised by tests everywhere, not just on a Windows runner.
 *
 * `renameFn` is injectable so tests can simulate transient failures without real file locking.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  renameFn: (from: string, to: string) => Promise<void> = fsRename,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await renameFn(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt === MAX_ATTEMPTS) break;
      await delay(attempt * BACKOFF_MS_PER_ATTEMPT);
    }
  }
  // Best effort: don't leave a stray .tmp file behind if the rename never succeeded.
  await unlink(from).catch(() => undefined);
  throw lastError;
}
