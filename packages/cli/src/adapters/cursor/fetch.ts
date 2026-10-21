import { stat } from 'node:fs/promises';
import { dateKey } from '@tokengraph/core';
import { processRootContext, type RootContext } from '../../agent-roots.js';
import { readConfig, writeConfig } from '../../config.js';
import { appendAccountRows, cursorAccountPath } from './accounts.js';
import { readCursorSignIn, type CursorSignIn } from './credentials.js';
import { fetchCursorUsageCsv, type FetchClientOptions } from './fetch-client.js';
import { readFetchState, writeFetchState, type CursorFetchState } from './fetch-state.js';

/**
 * Fetches the signed-in user's own Cursor usage from cursor.com and stores it (docs/agents/cursor-usage.md,
 * "Automatic history"). Runs under the sync lock. Everything it prints is a fixed, secret-free line.
 */

export const THROTTLE_MS = 3_600_000;
export const EXPIRED_BACKOFF_MS = 6 * 3_600_000;
const DEFAULT_RATE_LIMIT_WAIT_S = 3600;
const MIN_RATE_LIMIT_WAIT_S = 60;
const MAX_RATE_LIMIT_WAIT_S = 86_400;
/** Cursor's first public release; the first fetch asks for everything since. */
export const FIRST_START_MS = Date.UTC(2023, 0, 1);
const DAY_MS = 86_400_000;
/** Cursor can lag a little: every later fetch starts this many whole UTC days before the last covered day. */
export const OVERLAP_DAYS = 2;

export const ANNOUNCEMENT =
  "tokengraph now reads your Cursor usage from cursor.com, with Cursor's own sign-in on this machine (the sign-in is never stored). Turn it off with `tokengraph cursor off`.";
export const EXPIRED_LINE = "Cursor's sign-in has expired; open Cursor once, then run `tokengraph cursor fetch`.";

export type CursorFetchStatus =
  | 'fetched'
  | 'off'
  | 'not-announced'
  | 'backoff'
  | 'throttled'
  | 'not-installed'
  | 'signed-out'
  | 'unreadable'
  | 'no-sqlite'
  | 'expired'
  | 'rate-limited'
  | 'failed';

export interface CursorFetchReport {
  status: CursorFetchStatus;
  /** Lines worth printing now; empty when there is nothing to say. */
  lines: string[];
}

export interface CursorFetchDeps {
  context: RootContext;
  readSignIn: (context: RootContext) => Promise<CursorSignIn>;
  client: FetchClientOptions;
  now: () => Date;
}

const defaultDeps = (): CursorFetchDeps => ({
  context: processRootContext(),
  readSignIn: (context) => readCursorSignIn(context),
  client: {},
  now: () => new Date(),
});

export interface CursorFetchOptions {
  /** Who asked. Only a person at a terminal (`manual`) is told about the feature; hooks and schedules never are. */
  trigger: 'manual' | 'hook' | 'schedule';
  /** `tokengraph cursor fetch`: ignores the hourly throttle (never the back-off) and says why when it does nothing. */
  explicit?: boolean;
  deps?: Partial<CursorFetchDeps>;
}

const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** The request window, aligned to whole UTC days so rows that share a timestamp land in the same response. */
export function fetchWindow(coveredThrough: string | undefined, nowMs: number): { startMs: number; endMs: number } {
  const start = coveredThrough ? utcDayStart(Date.parse(coveredThrough)) - OVERLAP_DAYS * DAY_MS : FIRST_START_MS;
  return { startMs: Math.max(FIRST_START_MS, start), endMs: utcDayStart(nowMs) + DAY_MS - 1 };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export async function runCursorFetch(options: CursorFetchOptions): Promise<CursorFetchReport> {
  const deps = { ...defaultDeps(), ...options.deps };
  const explicit = options.explicit === true;
  const report = (status: CursorFetchStatus, ...lines: string[]): CursorFetchReport => ({ status, lines });

  const config = await readConfig();
  const setting = config.cursor?.fetch;
  if (setting === false) {
    return explicit ? report('off', 'Cursor fetching is off. Turn it on with `tokengraph cursor on`.') : report('off');
  }
  // Consent is announced to a person once, in the terminal. A background run never reads Cursor's files before that.
  if (setting === undefined && options.trigger !== 'manual') return report('not-announced');

  const now = deps.now();
  const state = await readFetchState();
  if (state.backoffUntil && Date.parse(state.backoffUntil) > now.getTime()) {
    return explicit || options.trigger === 'manual'
      ? report('backoff', `Cursor fetching is paused until ${clock(new Date(state.backoffUntil))}${state.lastError ? ` (${state.lastError})` : ''}.`)
      : report('backoff');
  }
  if (!explicit && state.lastAttemptAt && now.getTime() - Date.parse(state.lastAttemptAt) < THROTTLE_MS) return report('throttled');

  const signIn = await deps.readSignIn(deps.context);
  const quiet = !explicit && options.trigger !== 'manual';
  // A sync of someone who has no Cursor, or has not signed in, is not told about a feature it cannot use.
  const unprompted = !explicit && setting === undefined;
  if (signIn.kind === 'not-installed') return quiet || unprompted ? report('not-installed') : report('not-installed', 'Cursor is not installed here (no Cursor sign-in found).');
  if (signIn.kind === 'signed-out') return quiet || unprompted ? report('signed-out') : report('signed-out', 'Cursor is not signed in; sign in to Cursor, then run `tokengraph cursor fetch`.');
  if (signIn.kind === 'no-sqlite') {
    return quiet ? report('no-sqlite') : report('no-sqlite', 'Fetching Cursor history needs Node 22.13 or newer (node:sqlite); skipped.');
  }
  if (signIn.kind === 'unreadable') return quiet ? report('unreadable') : report('unreadable', "Cursor's sign-in could not be read (is Cursor updating?); skipped.");

  const lines: string[] = [];
  if (setting === undefined) {
    lines.push(ANNOUNCEMENT);
    await writeConfig({ ...(await readConfig()), cursor: { fetch: true } });
  }

  const save = async (change: Partial<CursorFetchState>): Promise<void> => {
    await writeFetchState({ ...state, ...change, coveredThrough: change.coveredThrough ?? state.coveredThrough });
  };

  if (signIn.expiresAt !== null && signIn.expiresAt * 1000 <= now.getTime()) {
    // No request is made with a token that is known to be dead; opening Cursor refreshes it.
    await save({ lastAttemptAt: now.toISOString(), lastError: 'sign-in expired' });
    return report('expired', ...lines, EXPIRED_LINE);
  }

  const covered = state.coveredThrough[signIn.accountKey];
  const hasFile = await fileExists(cursorAccountPath(signIn.accountKey));
  const window = fetchWindow(covered && hasFile ? covered : undefined, now.getTime());
  const outcome = await fetchCursorUsageCsv(
    { token: signIn.token, userId: signIn.userId, startMs: window.startMs, endMs: window.endMs },
    deps.client,
  );

  if (outcome.kind === 'ok') {
    const added = await appendAccountRows(signIn.accountKey, outcome.parsed.rows);
    const { lastError: _cleared, backoffUntil: _lifted, ...kept } = state;
    await writeFetchState({
      ...kept,
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      coveredThrough: { ...state.coveredThrough, [signIn.accountKey]: now.toISOString() },
    });
    return report('fetched', ...lines, `Cursor: ${added} new usage row${added === 1 ? '' : 's'} from cursor.com (history through ${dateKey(now)}).`);
  }
  if (outcome.kind === 'expired') {
    await save({ lastAttemptAt: now.toISOString(), lastError: 'sign-in expired', backoffUntil: new Date(now.getTime() + EXPIRED_BACKOFF_MS).toISOString() });
    return report('expired', ...lines, EXPIRED_LINE);
  }
  if (outcome.kind === 'rate-limited') {
    const wait = Math.min(MAX_RATE_LIMIT_WAIT_S, Math.max(MIN_RATE_LIMIT_WAIT_S, outcome.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_S));
    const until = new Date(now.getTime() + wait * 1000);
    await save({ lastAttemptAt: now.toISOString(), lastError: 'rate limited', backoffUntil: until.toISOString() });
    return report('rate-limited', ...lines, `cursor.com asked for a pause; Cursor history will be fetched again after ${clock(until)}.`);
  }
  await save({ lastAttemptAt: now.toISOString(), lastError: outcome.reason });
  return report('failed', ...lines, `Cursor history was not fetched: ${outcome.reason}. Your stored usage is unchanged.`);
}
