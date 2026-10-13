import { mkdir, writeFile } from 'node:fs/promises';
import {
  addCounts,
  addDays,
  dateKey,
  emptyCounts,
  formatTokens,
  renderGraphSvg,
  weightedTokens,
  type DailyModelUsage,
  type Theme,
  type TokenCounts,
} from '@tokengraph/core';
import { ApiError, uploadUsage } from '../api.js';
import { collectLocal, defaultAdapters, noAgentsMessage } from '../collect-local.js';
import { readConfig, resolveApiUrl } from '../config.js';
import { allLedgerUsage, ledgerToUsage, readLedger, writeLedger } from '../ledger.js';
import { buildUsagePayload } from '../payload.js';
import { configHome, ledgerPath, uploadRecordPath } from '../paths.js';
import { acquireSyncLock } from '../sync-lock.js';
import { uploadMode } from '../upload-mode.js';
import { pendingPayload, readUploadRecord, recordUpload, uploadTarget, writeUploadRecord } from '../upload-record.js';

/** What started a sync: the user, the Claude Code hook, or a scheduled run. */
export type SyncTrigger = 'manual' | 'hook' | 'schedule';

export interface SyncOptions {
  sinceDays: number;
  /** Update the ledger only, never upload (`--local`). */
  local?: boolean;
  svgPath?: string;
  theme: Theme;
  /** Defaults to 'manual'. */
  trigger?: SyncTrigger;
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
    console.error(`Another tokengraph sync is already running${lock.pid ? ` (pid ${lock.pid})` : ''}; skipping.`);
    return 0;
  }
  try {
    return await runSyncLocked(options);
  } finally {
    await lock.release();
  }
}

async function runSyncLocked(options: SyncOptions): Promise<number> {
  const since = addDays(new Date(), -options.sinceDays);
  const sinceKey = dateKey(since);

  const before = await readLedger(ledgerPath());
  // The order each adapter finished in, so failures print between the successes exactly where they happened.
  const outcomes: ('done' | 'failed')[] = [];
  const { ledger, results: collected, failures, detected } = await collectLocal(before, since, {
    adapters: defaultAdapters(),
    onProgress: (progress) => {
      if (progress.state !== 'scanning') outcomes.push(progress.state);
    },
  });
  if (detected.length === 0) {
    console.error(noAgentsMessage());
    return 1;
  }

  let nextResult = 0;
  let nextFailure = 0;
  for (const outcome of outcomes) {
    if (outcome === 'failed') {
      const failure = failures[nextFailure++]!;
      console.log(`source: ${failure.adapter}`);
      console.log(`  note: could not be read (${failure.message})`);
      continue;
    }
    const result = collected[nextResult++]!;
    const hadHistory = Object.keys(before.sources[result.source] ?? {}).length > 0;
    const days = summariseByDay(ledgerToUsage(ledger, result.source, sinceKey));
    const recovered = days.length - summariseByDay(result.usage).length;
    console.log(`source: ${result.source}`);
    console.log(`  distinct API requests read: ${result.requestCount}`);
    console.log(`  active days: ${days.length}`);
    if (hadHistory && recovered > 0) {
      console.log(`  (${recovered} of them survive only in the local ledger — their transcripts have been pruned)`);
    }
    for (const note of result.notes ?? []) console.log(`  note: ${note}`);
  }
  await mkdir(configHome(), { recursive: true, mode: 0o700 });
  await writeLedger(ledgerPath(), ledger);

  const days = summariseByDay(allLedgerUsage(ledger, sinceKey));
  console.log(`\nwindow: ${sinceKey} .. ${dateKey(new Date())} (${options.sinceDays} days), all agents`);
  for (const day of days.slice(-14)) {
    console.log(
      `  ${day.date}  ${formatTokens(day.weighted).padStart(8)}  ` +
        `(in ${formatTokens(day.counts.inputTokens)}, out ${formatTokens(day.counts.outputTokens)}, ` +
        `cache-write ${formatTokens(day.counts.cacheCreationTokens)}, cache-read ${formatTokens(day.counts.cacheReadTokens)})`,
    );
  }
  const total = days.reduce((sum, day) => sum + day.weighted, 0);
  console.log(`\ntotal weighted tokens: ${formatTokens(total)}`);
  console.log(`ledger: ${ledgerPath()}`);

  if (options.svgPath) {
    const svg = renderGraphSvg(days, { endDate: dateKey(new Date()), theme: options.theme });
    await writeFile(options.svgPath, svg, 'utf8');
    console.log(`wrote ${options.svgPath}`);
  }

  if (options.local) {
    console.log('\nSaved locally (--local) — nothing was uploaded.');
    return 0;
  }

  const config = await readConfig();
  const mode = uploadMode(config);
  if (mode === 'off') {
    console.log('\nUploads are off — saved locally only. Run `tokengraph uploads on` to resume.');
    return 0;
  }
  if (mode === 'local') {
    console.log('\nSaved locally. Explore it with `tokengraph view`, or run `tokengraph login` to publish your graph.');
    return 0;
  }
  // Unreachable (uploadMode === 'upload' implies both are set); narrows the types.
  if (!config.apiKey || !config.deviceId) return 1;

  const apiUrl = resolveApiUrl(config);
  const trigger = options.trigger ?? 'manual';
  // Background syncs run every hour and after every session, so they send only the days that
  // changed since the last upload. A manual sync sends the whole window: it is rare, and running
  // one is the way to repair a graph that is missing something.
  const onlyChanged = trigger !== 'manual';
  let record = await readUploadRecord(uploadRecordPath(), uploadTarget(apiUrl, config.deviceId));
  let recordChanged = false;
  let uploadFailed = false;
  let keyRejected = false;
  for (const result of collected) {
    const { payload: full, dropped } = buildUsagePayload(config.deviceId, result.source, ledgerToUsage(ledger, result.source, sinceKey));
    if (dropped > 0) console.log(`\n${result.source}: note: dropped ${dropped} invalid usage entr(ies) from upload`);
    if (!full) {
      console.log(`\n${result.source}: nothing to upload yet.`);
      continue;
    }
    const now = Date.now();
    const payload = onlyChanged ? pendingPayload(full, record, now) : full;
    if (!payload) {
      console.log(`\n${result.source}: nothing changed since the last upload.`);
      continue;
    }
    try {
      const uploaded = await uploadUsage(apiUrl, config.apiKey, payload, trigger);
      console.log(`\n${result.source}: uploaded ${uploaded.days} days to ${apiUrl}`);
      record = recordUpload(record, payload, now);
      recordChanged = true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        console.error('\nThe server rejected this API key. Run `tokengraph login` again.');
        keyRejected = true;
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n${result.source}: upload failed: ${message}`);
      uploadFailed = true;
    }
  }
  if (recordChanged) {
    try {
      await writeUploadRecord(uploadRecordPath(), record);
    } catch (error) {
      // Not fatal: the uploads landed, and without the record the next sync just sends more.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nnote: could not save ${uploadRecordPath()} (${message})`);
    }
  }
  return uploadFailed || keyRejected ? 1 : 0;
}
