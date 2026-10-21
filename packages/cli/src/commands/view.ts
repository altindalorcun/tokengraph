import { mkdir } from 'node:fs/promises';
import { dateKey, type Theme } from '@tokengraph/core';
import { collectLocal, defaultAdapters, noAgentsMessage } from '../collect-local.js';
import { readConfig } from '../config.js';
import { ledgerToUsage, mergeLedgerAccounts, mergeLedgerHours, mergeUsage, readLedger, writeLedger, type Ledger } from '../ledger.js';
import { configHome, ledgerPath } from '../paths.js';
import { acquireSyncLock } from '../sync-lock.js';
import { runApp, type AppDeps } from '../tui/app.js';
import { detectAutoSync } from '../tui/auto-sync.js';
import { detectColorDepth, openTerminal } from '../tui/terminal.js';
import { buildViewModel, shiftDate } from '../tui/model.js';
import { renderSnapshot } from '../tui/print.js';

export interface ViewOptions {
  motion: boolean;
  live: boolean;
  print: boolean;
  theme: 'auto' | Theme;
}

const SCAN_DAYS = 400;
const DEFAULT_PRINT_WIDTH = 100;

/** `COLORFGBG` is "foreground;background" palette indexes; 7..15 as the background means a light terminal. */
function resolveTheme(theme: ViewOptions['theme'], env: NodeJS.ProcessEnv): Theme {
  if (theme !== 'auto') return theme;
  const background = Number(env['COLORFGBG']?.split(';').pop());
  return Number.isInteger(background) && background >= 7 && background <= 15 ? 'light' : 'dark';
}

/**
 * Writes `ledger` under the sync lock, or reports 'busy' without waiting. The file may have grown since it was
 * loaded (a hook-triggered sync), so ours is merged into what is on disk; totals only ever grow.
 */
async function persistLedger(ledger: Ledger): Promise<'saved' | 'busy'> {
  const lock = await acquireSyncLock();
  if (!lock.acquired) return 'busy';
  try {
    await mkdir(configHome(), { recursive: true });
    let merged = await readLedger(ledgerPath());
    for (const source of Object.keys(ledger.sources) as (keyof Ledger['sources'])[]) {
      merged = mergeUsage(merged, source, ledgerToUsage(ledger, source));
    }
    merged = mergeLedgerAccounts(merged, ledger.accounts);
    merged = mergeLedgerHours(merged, ledger);
    await writeLedger(ledgerPath(), merged);
    return 'saved';
  } finally {
    await lock.release();
  }
}

async function modeLabel(): Promise<string> {
  const config = await readConfig();
  return config.github ? `↑ publishing as @${config.github.login}` : 'local only';
}

/** Scans with sync's adapter set, so the view matches what sync records. */
function scan(ledger: Ledger, since: Date, onProgress: Parameters<AppDeps['scan']>[2]) {
  return collectLocal(ledger, since, { adapters: defaultAdapters(), onProgress });
}

async function printSnapshot(options: ViewOptions): Promise<number> {
  const today = dateKey(new Date());
  const collected = await collectLocal(await readLedger(ledgerPath()), new Date(`${shiftDate(today, -SCAN_DAYS)}T00:00:00`), {
    adapters: defaultAdapters(),
  });
  const vm = buildViewModel(collected.ledger, today);
  if (vm.days.length === 0 && collected.detected.length === 0) {
    console.log(noAgentsMessage());
    return 0;
  }
  try {
    await persistLedger(collected.ledger);
  } catch {
    // The snapshot is still correct; a read-only home directory should not fail a print.
  }
  const out = renderSnapshot(vm, {
    width: process.stdout.columns ?? DEFAULT_PRINT_WIDTH,
    theme: resolveTheme(options.theme, process.env),
    depth: detectColorDepth(process.env, process.stdout.isTTY === true),
    mode: await modeLabel(),
  });
  console.log(out);
  return 0;
}

/** Opens the terminal dashboard, or prints a static snapshot when asked to or when stdout is not a terminal. */
export async function runView(options: ViewOptions): Promise<number> {
  // Raw mode needs a TTY on both ends; without stdin the user could not even quit with Ctrl-C cleanly.
  if (options.print || !process.stdout.isTTY || !process.stdin.isTTY) return printSnapshot(options);
  const terminal = openTerminal({ stdin: process.stdin, stdout: process.stdout });
  return runApp({
    terminal,
    depth: detectColorDepth(process.env, true),
    theme: resolveTheme(options.theme, process.env),
    motion: options.motion && process.env['TOKENGRAPH_NO_MOTION'] !== '1',
    live: options.live,
    clock: () => performance.now(),
    today: () => dateKey(new Date()),
    loadLedger: () => readLedger(ledgerPath()),
    scan,
    persist: persistLedger,
    modeLabel,
    autoSync: () => detectAutoSync(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
}
