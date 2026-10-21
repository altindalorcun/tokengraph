import { foldCursorAccounts } from '../adapters/cursor/accounts.js';
import { runCursorFetch, type CursorFetchDeps } from '../adapters/cursor/fetch.js';
import { readFetchState } from '../adapters/cursor/fetch-state.js';
import { readConfig, writeConfig } from '../config.js';
import { readLedger, writeLedger } from '../ledger.js';
import { configHome, ledgerPath } from '../paths.js';
import { acquireSyncLock } from '../sync-lock.js';
import { mkdir } from 'node:fs/promises';

export const CURSOR_ACTIONS = ['fetch', 'on', 'off'] as const;
export type CursorAction = (typeof CURSOR_ACTIONS)[number];

/** Validates the positionals; returns the action, or the error message to print. */
export function parseCursorArgs(positionals: readonly string[]): CursorAction | string {
  const [action, ...extra] = positionals;
  if (action === undefined || !(CURSOR_ACTIONS as readonly string[]).includes(action) || extra.length > 0) {
    return `Usage: tokengraph cursor <${CURSOR_ACTIONS.join('|')}>`;
  }
  return action as CursorAction;
}

/**
 * `tokengraph cursor fetch`: fetches now, ignoring the hourly throttle (never a back-off), and folds the result
 * into the ledger. The sync lock is held for the whole run. Nothing is published.
 */
export async function runCursorFetchNow(deps: Partial<CursorFetchDeps> = {}): Promise<number> {
  const lock = await acquireSyncLock();
  if (!lock.acquired) {
    console.error(`Another tokengraph sync is already running${lock.pid ? ` (pid ${lock.pid})` : ''}; try again in a minute.`);
    return 1;
  }
  try {
    const report = await runCursorFetch({ trigger: 'manual', explicit: true, deps });
    for (const line of report.lines) (report.status === 'fetched' ? console.log : console.error)(line);
    if (report.status !== 'fetched') return 1;
    const folded = await foldCursorAccounts(await readLedger(ledgerPath()), await readFetchState());
    await mkdir(configHome(), { recursive: true, mode: 0o700 });
    await writeLedger(ledgerPath(), folded);
    if ((await readConfig()).github) console.log('Run `tokengraph sync` to publish.');
    return 0;
  } finally {
    await lock.release();
  }
}

export async function runCursor(action: CursorAction, deps: Partial<CursorFetchDeps> = {}): Promise<number> {
  if (action === 'fetch') return runCursorFetchNow(deps);
  const config = await readConfig();
  await writeConfig({ ...config, cursor: { fetch: action === 'on' } });
  if (action === 'on') {
    console.log('Cursor fetching is on: `tokengraph sync` reads your Cursor usage from cursor.com with Cursor\'s own sign-in. Run `tokengraph cursor fetch` to do it now.');
  } else {
    console.log(
      'Cursor fetching is off: tokengraph will not read Cursor\'s sign-in or call cursor.com. Usage already fetched stays in your ledger; ' +
        'hook events and `tokengraph import cursor <file.csv>` keep working.',
    );
  }
  return 0;
}
