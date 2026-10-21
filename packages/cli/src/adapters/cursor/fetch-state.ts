import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { clampInstant } from '../../clamp-instant.js';
import { cursorFetchStatePath } from '../../paths.js';

/**
 * What the Cursor fetch remembers between runs. It holds timestamps, a fixed error text and, per account
 * key (a hash of the user id), how far that account's history is covered. It never holds a token, a
 * cookie, an e-mail address or a user id.
 */
export interface CursorFetchState {
  /** ISO instant of the last request, successful or not: the once-an-hour throttle counts from it. */
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  /** No request before this ISO instant (401/403 or 429). */
  backoffUntil?: string;
  /** A fixed, secret-free text for the last failure; cleared by a success. */
  lastError?: string;
  coveredThrough: Record<string, string>;
}

const ACCOUNT_KEY = /^[0-9a-f]{16}$/;

function instant(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

export function parseFetchState(raw: unknown): CursorFetchState {
  const state: CursorFetchState = { coveredThrough: {} };
  if (typeof raw !== 'object' || raw === null) return state;
  const fields = raw as Record<string, unknown>;
  // A timestamp from the future (a clock that ran ahead once) would throttle fetching until then.
  const past = (value: unknown): string | undefined => (typeof value === 'string' ? (clampInstant(value) ?? undefined) : undefined);
  const lastAttemptAt = past(fields['lastAttemptAt']);
  const lastSuccessAt = past(fields['lastSuccessAt']);
  const backoffUntil = instant(fields['backoffUntil']);
  if (lastAttemptAt) state.lastAttemptAt = lastAttemptAt;
  if (lastSuccessAt) state.lastSuccessAt = lastSuccessAt;
  if (backoffUntil) state.backoffUntil = backoffUntil;
  if (typeof fields['lastError'] === 'string') state.lastError = fields['lastError'].slice(0, 200);
  const covered = fields['coveredThrough'];
  if (typeof covered === 'object' && covered !== null) {
    for (const [key, value] of Object.entries(covered as Record<string, unknown>)) {
      const at = typeof value === 'string' ? clampInstant(value) : null;
      if (ACCOUNT_KEY.test(key) && at) state.coveredThrough[key] = at;
    }
  }
  return state;
}

export async function readFetchState(path = cursorFetchStatePath()): Promise<CursorFetchState> {
  try {
    return parseFetchState(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return { coveredThrough: {} };
  }
}

export async function writeFetchState(state: CursorFetchState, path = cursorFetchStatePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
