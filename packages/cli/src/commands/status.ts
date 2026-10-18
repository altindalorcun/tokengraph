import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatTokens, isKnownSource } from '@tokengraph/core';
import { inspectAutoSync, type AutoSyncEntry, type AutoSyncHealth } from '../auto-sync-health.js';
import { cliVersion } from '../bin-path.js';
import { readConfig } from '../config.js';
import { allLedgerUsage, readLedger } from '../ledger.js';
import { configHome, hookSyncLogPath, ledgerPath, legacyConfigHome } from '../paths.js';
import { activeDayCount, machineLabel } from '../publish/machines.js';
import { readLastPublish, readMachinesCache } from '../publish/machines-cache.js';
import { formatDays, readRetentionPolicies, retentionWarnings, type RetentionPolicy } from '../retention.js';
import { summariseByDay } from './sync.js';

export interface StatusDeps {
  autoSync: () => Promise<AutoSyncHealth>;
  /** Whether the pre-release `~/.token-graph` folder still holds data that was not moved. */
  legacyData: () => string[];
  /** The data-retention policy of each agent that auto-deletes its logs and is installed here. */
  retention: () => Promise<RetentionPolicy[]>;
}

const DEFAULT_DEPS: StatusDeps = {
  autoSync: () => inspectAutoSync(),
  retention: () => readRetentionPolicies(),
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
  console.log(`github:  ${config.github ? `@${config.github.login} (${config.github.auth.kind === 'gh' ? 'via gh' : 'tokengraph login'})` : 'not logged in'}`);
  console.log(`machine: ${config.machineId ? `${config.machineId} (${machineLabel(process.platform, config.machineId)})` : 'not set yet (set on first publish)'}`);
  const lastPublish = await readLastPublish();
  if (lastPublish) console.log(`last publish: ${new Date(lastPublish).toLocaleString()}`);
  if (config.gists?.graph && config.github) console.log(`graph:   https://gist.github.com/${config.github.login}/${config.gists.graph}`);
  if (config.gists?.data && config.github) console.log(`data:    https://gist.github.com/${config.github.login}/${config.gists.data} (secret)`);
  const others = await readMachinesCache();
  if (others.length > 0) {
    console.log('other machines (as of the last publish):');
    for (const other of others) console.log(`  ${other.label}  updated ${other.updatedAt.slice(0, 10)}  ${activeDayCount(other.sources)} days`);
  }
  console.log(`ledger:  ${days.length} active days in ${ledgerPath()}`);
  for (const source of Object.keys(ledger.sources).filter(isKnownSource)) {
    console.log(`  ${source}: ${Object.keys(ledger.sources[source] ?? {}).length} days`);
  }
  for (const day of days.slice(-7)) {
    console.log(`  ${day.date}  ${formatTokens(day.weighted).padStart(8)}`);
  }
  const autoSync = await deps.autoSync();
  printAutoSync(autoSync);
  printRetention(await deps.retention(), autoSync);
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

function retentionLine(policy: RetentionPolicy): string {
  const where = `${policy.setting} in ${policy.configPath}`;
  if (policy.state === 'keeps') return policy.source === 'gemini-cli' ? `keeps sessions (${policy.setting} is off in ${policy.configPath})` : `keeps transcripts (${where})`;
  if (policy.state === 'unknown') return `unknown (could not read ${where})`;
  const what = policy.source === 'gemini-cli' ? 'sessions' : 'transcripts';
  return `deletes ${what} after ${formatDays(policy.days ?? 0)} (${policy.isDefault ? 'default; ' : ''}${where})`;
}

export function printRetention(policies: RetentionPolicy[], autoSync: AutoSyncHealth): void {
  if (policies.length === 0) return;
  console.log('data retention:');
  for (const policy of policies) console.log(`  ${`${policy.source}:`.padEnd(18)}${retentionLine(policy)}`);
  for (const warning of retentionWarnings(policies, autoSync)) console.log(`warning: ${warning}`);
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
