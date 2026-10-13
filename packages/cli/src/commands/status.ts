import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatTokens, isKnownSource } from '@tokengraph/core';
import { inspectAutoSync, type AutoSyncEntry, type AutoSyncHealth } from '../auto-sync-health.js';
import { cliVersion } from '../bin-path.js';
import { readConfig, resolveApiUrl, type CliConfig } from '../config.js';
import { allLedgerUsage, readLedger } from '../ledger.js';
import { configHome, hookSyncLogPath, ledgerPath, legacyConfigHome } from '../paths.js';
import { uploadMode } from '../upload-mode.js';
import { summariseByDay } from './sync.js';

function statusUploads(config: CliConfig): string {
  const mode = uploadMode(config);
  return mode === 'upload' ? 'on' : mode === 'off' ? 'off' : 'local only (not logged in)';
}

export interface StatusDeps {
  autoSync: () => Promise<AutoSyncHealth>;
  /** Whether the pre-release `~/.token-graph` folder still holds data that was not moved. */
  legacyData: () => string[];
}

const DEFAULT_DEPS: StatusDeps = {
  autoSync: () => inspectAutoSync(),
  legacyData: () => {
    const legacy = legacyConfigHome();
    if (legacy === configHome()) return [];
    return ['state.json', 'cursor-events.jsonl'].map((file) => join(legacy, file)).filter((path) => existsSync(path));
  },
};

export async function runStatus(overrides: Partial<StatusDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const config = await readConfig();
  const ledger = await readLedger(ledgerPath());
  const days = summariseByDay(allLedgerUsage(ledger));

  console.log(`version: ${cliVersion()}`);
  console.log(`account: ${config.apiKey ? (config.username ?? 'logged in') : 'not logged in'}`);
  console.log(`server:  ${resolveApiUrl(config)}`);
  console.log(`device:  ${config.deviceId ?? 'not linked'}`);
  console.log(`uploads: ${statusUploads(config)}`);
  console.log(`ledger:  ${days.length} active days in ${ledgerPath()}`);
  for (const source of Object.keys(ledger.sources).filter(isKnownSource)) {
    console.log(`  ${source}: ${Object.keys(ledger.sources[source] ?? {}).length} days`);
  }
  for (const day of days.slice(-7)) {
    console.log(`  ${day.date}  ${formatTokens(day.weighted).padStart(8)}`);
  }
  printAutoSync(await deps.autoSync());
  await printHookSync();
  const leftovers = deps.legacyData();
  if (leftovers.length > 0) {
    console.log(`\nnote: data from an older version was not moved to ${configHome()}:`);
    for (const path of leftovers) console.log(`  ${path}`);
    console.log('  It is not read any more. Keep it until you have checked your totals, then merge or delete it by hand.');
  }
  return 0;
}

const AUTO_SYNC_ROWS: { key: keyof AutoSyncHealth; label: string; reinstall: string }[] = [
  { key: 'claudeHook', label: 'claude-code hook', reinstall: 'tokengraph install-hook --agent claude-code' },
  { key: 'cursorHook', label: 'cursor hook', reinstall: 'tokengraph install-hook --agent cursor' },
  { key: 'codexNotify', label: 'codex notify', reinstall: 'tokengraph install-hook --agent codex' },
  { key: 'schedule', label: 'hourly schedule', reinstall: 'tokengraph schedule' },
];

function describe(entry: AutoSyncEntry): string {
  if (entry.installed === null) return 'unknown';
  if (!entry.installed) return 'not installed';
  const where = entry.detail ? ` (${entry.detail})` : '';
  return entry.missing.length > 0 ? `BROKEN${where}` : `installed${where}`;
}

export function printAutoSync(health: AutoSyncHealth): void {
  console.log('background sync:');
  for (const row of AUTO_SYNC_ROWS) {
    const entry = health[row.key];
    console.log(`  ${`${row.label}:`.padEnd(18)}${describe(entry)}`);
    if (entry.installed && entry.missing.length > 0) {
      for (const path of entry.missing) console.log(`    runs ${path}, which no longer exists`);
      console.log(`    fix: ${row.reinstall}`);
    }
  }
}

async function printHookSync(): Promise<void> {
  const path = hookSyncLogPath();
  try {
    const info = await stat(path);
    console.log(`last hook sync: ${info.mtime.toISOString()} (${path})`);
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((line) => line.trim() !== '');
    const last = lines[lines.length - 1];
    if (last !== undefined && /error|failed/i.test(last)) console.log(`  ${last.trim()}`);
  } catch {
    // No hook sync has run yet.
  }
}
