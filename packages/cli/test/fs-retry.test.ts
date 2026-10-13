import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renameWithRetry } from '../src/fs-retry.js';

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('renameWithRetry', () => {
  it('succeeds immediately when the rename does not fail', async () => {
    const renameFn = vi.fn().mockResolvedValue(undefined);
    await renameWithRetry('from', 'to', renameFn);
    expect(renameFn).toHaveBeenCalledTimes(1);
    expect(renameFn).toHaveBeenCalledWith('from', 'to');
  });

  it('retries past transient EPERM/EACCES/EBUSY failures and eventually succeeds', async () => {
    const renameFn = vi
      .fn()
      .mockRejectedValueOnce(errnoError('EPERM'))
      .mockRejectedValueOnce(errnoError('EACCES'))
      .mockRejectedValueOnce(errnoError('EBUSY'))
      .mockResolvedValue(undefined);

    await renameWithRetry('from', 'to', renameFn);
    expect(renameFn).toHaveBeenCalledTimes(4);
  });

  it('rethrows a non-retryable error immediately without retrying', async () => {
    const renameFn = vi.fn().mockRejectedValue(errnoError('ENOENT'));
    await expect(renameWithRetry('from', 'to', renameFn)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(renameFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the max number of attempts and rethrows the last error', async () => {
    vi.useFakeTimers();
    try {
      const renameFn = vi.fn().mockRejectedValue(errnoError('EPERM'));
      const result = renameWithRetry('from', 'to', renameFn);
      const assertion = expect(result).rejects.toMatchObject({ code: 'EPERM' });
      await vi.runAllTimersAsync();
      await assertion;
      expect(renameFn).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the temporary file (best effort) when every retry fails', async () => {
    vi.useFakeTimers();
    try {
      const dir = await mkdtemp(join(tmpdir(), 'fs-retry-'));
      const from = join(dir, 'state.json.tmp');
      await writeFile(from, 'partial');
      const renameFn = vi.fn().mockRejectedValue(errnoError('EBUSY'));

      const result = renameWithRetry(from, join(dir, 'state.json'), renameFn);
      const assertion = expect(result).rejects.toMatchObject({ code: 'EBUSY' });
      await vi.runAllTimersAsync();
      await assertion;
      await expect(readFile(from, 'utf8')).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs a real rename end to end using the default fs rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-retry-real-'));
    const from = join(dir, 'source.txt');
    const to = join(dir, 'dest.txt');
    await writeFile(from, 'hello');

    await renameWithRetry(from, to);
    expect(await readFile(to, 'utf8')).toBe('hello');
  });
});
