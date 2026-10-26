import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  addCounts,
  agentName,
  dateKey,
  emptyCounts,
  formatTokens,
  renderPublishedGraphs,
  shiftDate,
  weightedTokens,
  type DailyModelUsage,
  type Theme,
  type TokenCounts,
} from '@tokengraph/core';
import { foldCursorAccounts } from '../adapters/cursor/accounts.js';
import { runCursorFetch, type CursorFetchDeps } from '../adapters/cursor/fetch.js';
import { readFetchState } from '../adapters/cursor/fetch-state.js';
import { cliVersion } from '../bin-path.js';
import { collectLocal, defaultAdapters, noAgentsMessage } from '../collect-local.js';
import { readConfig, writeConfig, type CliConfig, type GitHubAccount, type GitHubAuth } from '../config.js';
import { clientFor } from '../github/auth.js';
import { GitHubAuthError, GitHubError, GitHubNotFoundError, GitHubRateLimitError, type GitHubClient } from '../github/http.js';
import { allLedgerUsage, ledgerToUsage, readLedger, writeLedger, type Ledger } from '../ledger.js';
import { configHome, ledgerPath } from '../paths.js';
import { currentFingerprint } from '../publish/machine-identity.js';
import { writeMachinesCache } from '../publish/machines-cache.js';
import { publish, type PublishResult } from '../publish/publish.js';
import { readmeSnippet } from '../readme-snippet.js';
import { createSpinner, spinnerEnabled, type Spinner } from '../spinner.js';
import { acquireSyncLock } from '../sync-lock.js';

/**
 * Exit code `runSync` returns, when asked (`detailedExit`), for a run that did nothing because another
 * sync holds the lock. Never an exit code of the CLI itself: a skip is success there.
 */
export const SYNC_SKIPPED = 3;
/** Exit code `runSync` returns, when asked (`detailedExit`), when no agent has any usage on this machine. */
export const SYNC_NO_AGENTS = 4;

/** What started a sync: the user, the Claude Code hook, or a scheduled run. */
export type SyncTrigger = 'manual' | 'hook' | 'schedule';

/** The outside world `sync` publishes through; tests replace it. */
export interface SyncPublishDeps {
  clientFor: (auth: GitHubAuth) => GitHubClient;
  fingerprint: () => Promise<string>;
  newMachineId: () => string;
  now: () => Date;
  /** Replaces the parts of the Cursor fetch that touch Cursor's files and the network. */
  cursor?: Partial<CursorFetchDeps>;
}

export interface SyncOptions {
  sinceDays: number;
  /** Update the ledger only, never publish (`--local`). */
  local?: boolean;
  svgPath?: string;
  theme: Theme;
  /** Defaults to 'manual'. */
  trigger?: SyncTrigger;
  /** Print only the publish summary (used when another command republishes). */
  quiet?: boolean;
  /** Return SYNC_SKIPPED / SYNC_NO_AGENTS (silently) instead of 0 / 1 for those two cases, for callers that react to them. */
  detailedExit?: boolean;
  /** Shows the slow steps. Defaults to one on stderr when a person runs sync in a terminal; tests pass their own. */
  spinner?: Spinner;
  deps?: Partial<SyncPublishDeps>;
}

export interface DayTotal {
  date: string;
  counts: TokenCounts;
  weighted: number;
}

export function summariseByDay(usage: readonly DailyModelUsage[]): DayTotal[] {
  const byDate = new Map<string, TokenCounts>();
  for (const entry of usage) {
    byDate.set(entry.date, addCounts(byDate.get(entry.date) ?? emptyCounts(), entry.counts));
  }
  return [...byDate.entries()]
    .map(([date, counts]) => ({ date, counts, weighted: weightedTokens(counts) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function runSync(options: SyncOptions): Promise<number> {
  // Held for the whole run (--local too — it writes the ledger) so two sessions ending at once
  // don't race on state.json. Skipping is success: the running sync covers the same data.
  const lock = await acquireSyncLock();
  if (!lock.acquired) {
    if (options.detailedExit) return SYNC_SKIPPED;
    console.error(`Another tokengraph sync is already running${lock.pid ? ` (pid ${lock.pid})` : ''}; skipping.`);
    return 0;
  }
  // Also on for --quiet: `login` and `readme --colors` wait on this sync too, and the spinner is not output.
  const spinner =
    options.spinner ??
    createSpinner(process.stderr, { enabled: (options.trigger ?? 'manual') === 'manual' && spinnerEnabled(process.stderr, process.env) });
  try {
    return await runSyncLocked(options, spinner);
  } finally {
    spinner.stop();
    await lock.release();
  }
}

async function runSyncLocked(options: SyncOptions, spinner: Spinner): Promise<number> {
  // From local midnight, so the window is whole days: `--since 7` is today and the six days before it, and no
  // day at its start is half read (which would look like history surviving only in the ledger). Calendar days,
  // not 24-hour blocks, so a daylight-saving change never moves the start by a day.
  const sinceKey = shiftDate(dateKey(new Date()), -(options.sinceDays - 1));
  const since = new Date(`${sinceKey}T00:00:00`);

  const say = (line: string): void => {
    if (options.quiet) return;
    spinner.clear();
    console.log(line);
  };
  let before = await readLedger(ledgerPath());
  before = await cursorStep(before, options, say, spinner);
  // The order each adapter finished in, so failures print between the successes exactly where they happened.
  const outcomes: ('done' | 'failed')[] = [];
  const { ledger, results: collected, failures, detected } = await collectLocal(before, since, {
    adapters: defaultAdapters(),
    onProgress: (progress) => {
      if (progress.state === 'scanning') spinner.start(`Reading ${agentName(progress.adapter)}…`);
      else outcomes.push(progress.state);
    },
  });
  spinner.stop();
  if (detected.length === 0) {
    if (options.detailedExit) return SYNC_NO_AGENTS;
    console.error(noAgentsMessage());
    return 1;
  }

  let nextResult = 0;
  let nextFailure = 0;
  for (const outcome of outcomes) {
    if (outcome === 'failed') {
      const failure = failures[nextFailure++]!;
      say(`source: ${failure.adapter}`);
      say(`  note: could not be read (${failure.message})`);
      continue;
    }
    const result = collected[nextResult++]!;
    const hadHistory = Object.keys(before.sources[result.source] ?? {}).length > 0;
    const days = summariseByDay(ledgerToUsage(ledger, result.source, sinceKey));
    const recovered = days.length - summariseByDay(result.usage).length;
    say(`source: ${result.source}`);
    say(`  distinct API requests read: ${result.requestCount}`);
    say(`  active days: ${days.length}`);
    if (hadHistory && recovered > 0) {
      say(`  (${recovered} of them ${recovered === 1 ? 'survives' : 'survive'} only in the local ledger — their transcripts have been pruned)`);
    }
    for (const note of result.notes ?? []) say(`  note: ${note}`);
  }
  await mkdir(configHome(), { recursive: true, mode: 0o700 });
  await writeLedger(ledgerPath(), ledger);

  const days = summariseByDay(allLedgerUsage(ledger, sinceKey));
  say(`\nwindow: ${sinceKey} .. ${dateKey(new Date())} (${options.sinceDays} days), all agents`);
  for (const day of days.slice(-14)) {
    say(
      `  ${day.date}  ${formatTokens(day.weighted).padStart(8)}  ` +
        `(in ${formatTokens(day.counts.inputTokens)}, out ${formatTokens(day.counts.outputTokens)}, ` +
        `cache-write ${formatTokens(day.counts.cacheCreationTokens)}, cache-read ${formatTokens(day.counts.cacheReadTokens)})`,
    );
  }
  const total = days.reduce((sum, day) => sum + day.weighted, 0);
  say(`\ntotal weighted tokens: ${formatTokens(total)}`);
  say(`ledger: ${ledgerPath()}`);

  if (options.svgPath) {
    const files = renderPublishedGraphs(allLedgerUsage(ledger), { today: dateKey(new Date()), colors: 'model' });
    await writeFile(options.svgPath, files[options.theme === 'dark' ? 'tokengraph-dark.svg' : 'tokengraph-light.svg'], 'utf8');
    say(`wrote ${options.svgPath}`);
  }

  if (options.local) {
    say('\nSaved locally (--local).');
    return 0;
  }
  const config = await readConfig();
  if (!config.github) {
    console.log('\nSaved locally. Run `tokengraph login` to put this graph in your GitHub README.');
    return 0;
  }
  return publishFromSync(ledger, config, config.github, options, spinner);
}

/**
 * Fetches the signed-in Cursor user's history from cursor.com (unless `--local`), then folds every stored
 * account file into the ledger. Cursor trouble never fails a sync: it is one line and the run goes on.
 */
async function cursorStep(ledger: Ledger, options: SyncOptions, say: (line: string) => void, spinner: Spinner): Promise<Ledger> {
  try {
    if (!options.local) {
      spinner.start('Checking Cursor usage…');
      const report = await runCursorFetch({ trigger: options.trigger ?? 'manual', silent: options.quiet === true, deps: options.deps?.cursor });
      for (const line of report.lines) say(line);
    }
    return await foldCursorAccounts(ledger, await readFetchState());
  } catch (error) {
    say(`Cursor history was skipped: ${error instanceof Error ? error.message : String(error)}`);
    return ledger;
  }
}

const DEFAULT_PUBLISH_DEPS: SyncPublishDeps = {
  clientFor: (auth) => clientFor(auth),
  fingerprint: () => currentFingerprint(),
  newMachineId: () => randomUUID(),
  now: () => new Date(),
};

async function publishFromSync(
  ledger: Ledger,
  config: CliConfig,
  github: GitHubAccount,
  options: SyncOptions,
  spinner: Spinner,
): Promise<number> {
  const deps = { ...DEFAULT_PUBLISH_DEPS, ...options.deps };
  const now = deps.now();
  let result: PublishResult;
  spinner.start('Publishing your graph to GitHub…');
  try {
    result = await publish({
      client: deps.clientFor(github.auth),
      login: github.login,
      config,
      ledger,
      today: dateKey(now),
      nowIso: now.toISOString(),
      cliVersion: cliVersion(),
      platform: process.platform,
      fingerprint: await deps.fingerprint(),
      newMachineId: deps.newMachineId,
      persistMachineId: async (id) => {
        const current = await readConfig();
        if (current.machineId !== id) await writeConfig({ ...current, machineId: id });
      },
    });
  } catch (error) {
    spinner.stop();
    if (error instanceof GitHubAuthError) {
      console.error('\nGitHub no longer accepts this login. Run `tokengraph login` again. Your usage is saved locally.');
    } else if (error instanceof GitHubNotFoundError) {
      // After `gh auth switch` the stored login is stale: the cached gists are readable but not writable.
      console.error(
        '\nYour gists belong to a different GitHub account than the one you are signed in with now. Run `tokengraph login` to publish as the current account. Your usage is saved locally.',
      );
    } else if (error instanceof GitHubRateLimitError) {
      const when = error.resetAt ? ` after ${error.resetAt.toLocaleTimeString()}` : ' later';
      console.error(`\nGitHub is rate-limiting requests; the graph will update on a sync${when}. Your usage is saved locally.`);
    } else if (error instanceof GitHubError) {
      console.error(`\nCould not publish: ${error.message}. Your usage is saved locally.`);
    } else {
      throw error;
    }
    return 1;
  }
  spinner.stop();

  if (result.restoredDays > 0 || result.ledger !== ledger) await writeLedger(ledgerPath(), result.ledger);
  // The publish took several round trips: a logout, login or `readme --colors` may have happened in
  // between. Merge in only what this run learned, and nothing at all for another account.
  const current = await readConfig();
  const sameAccount = current.github?.login.toLowerCase() === github.login.toLowerCase();
  if (sameAccount) {
    const { machineId, gists } = result.config;
    await writeConfig({ ...current, ...(machineId ? { machineId } : {}), ...(gists ? { gists } : {}) });
    await writeMachinesCache(result.others, undefined, now.toISOString());
  }

  const graphUrl = `https://gist.github.com/${github.login}/${result.graphGistId}`;
  if (result.adopted) console.log(`\nRestored this machine's history (${result.restoredDays} days) from your data gist.`);
  else if (result.restoredDays > 0) console.log(`\nRecovered ${result.restoredDays} days from your data gist.`);
  if (result.others.length > 0) console.log(`\nCombined with ${result.others.length} other machine${result.others.length === 1 ? '' : 's'}.`);
  if (result.ownFileUnreadable) {
    console.log(
      "\n⚠ This machine's file in your data gist could not be read (it may come from a newer tokengraph). " +
        'It was left untouched; update tokengraph with npm install -g tokengraph.',
    );
  }
  if (result.graphGistReplaced) {
    console.log('\n⚠ Your graph gist was missing, so a new one was made. Update your README with:\n');
    console.log(readmeSnippet(github.login, result.graphGistId));
  }
  console.log(result.updatedGraphFiles.length > 0 ? `\n✓ Graph published: ${graphUrl}` : `\n✓ Graph up to date: ${graphUrl}`);
  return 0;
}
