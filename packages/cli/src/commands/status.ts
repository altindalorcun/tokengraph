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

/** Everything `status` knows, built once and printed as text or as `--json`. */
export interface StatusReport {
  schema: 1;
  version: string;
  github: { login: string; auth: 'gh' | 'token' } | null;
  machine: { id: string; label: string } | null;
  lastPublish: string | null;
  gists: { graph: string | null; data: string | null };
  otherMachines: { label: string; updatedAt: string; activeDays: number }[];
  ledger: { path: string; activeDays: number; sources: Record<string, number>; recentDays: { date: string; weighted: number }[] };
  backgroundSync: Record<keyof AutoSyncHealth, { installed: boolean | null; detail: string | null; missing: string[] }>;
  lastHookSync: { at: string; error: string | null } | null;
  retention: RetentionPolicy[];
  warnings: string[];
  legacyData: string[];
}

async function readHookSync(): Promise<StatusReport['lastHookSync']> {
  const path = hookSyncLogPath();
  try {
    const info = await stat(path);
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((line) => line.trim() !== '');
    const last = lines[lines.length - 1];
    return { at: info.mtime.toISOString(), error: last !== undefined && /error|failed/i.test(last) ? last.trim() : null };
  } catch {
    return null; // No hook sync has run yet.
  }
}

async function buildReport(deps: StatusDeps, autoSync: AutoSyncHealth): Promise<StatusReport> {
  const config = await readConfig();
  const ledger = await readLedger(ledgerPath());
  const days = summariseByDay(allLedgerUsage(ledger));
  const login = config.github?.login;
  const gistUrl = (id: string | undefined) => (id && login ? `https://gist.github.com/${login}/${id}` : null);
  const retention = await deps.retention();
  return {
    schema: 1,
    version: cliVersion(),
    github: config.github ? { login: config.github.login, auth: config.github.auth.kind } : null,
    machine: config.machineId ? { id: config.machineId, label: machineLabel(process.platform, config.machineId) } : null,
    lastPublish: await readLastPublish(),
    gists: { graph: gistUrl(config.gists?.graph), data: gistUrl(config.gists?.data) },
    otherMachines: (await readMachinesCache()).map((other) => ({ label: other.label, updatedAt: other.updatedAt, activeDays: activeDayCount(other.sources) })),
    ledger: {
      path: ledgerPath(),
      activeDays: days.length,
      sources: Object.fromEntries(Object.keys(ledger.sources).filter(isKnownSource).map((source) => [source, Object.keys(ledger.sources[source] ?? {}).length])),
      recentDays: days.slice(-7).map((day) => ({ date: day.date, weighted: day.weighted })),
    },
    backgroundSync: Object.fromEntries(
      AUTO_SYNC_ROWS.map(({ key }) => [key, { installed: autoSync[key].installed, detail: autoSync[key].detail ?? null, missing: autoSync[key].missing }]),
    ) as StatusReport['backgroundSync'],
    lastHookSync: await readHookSync(),
    retention,
    warnings: retentionWarnings(retention, autoSync),
    legacyData: deps.legacyData(),
  };
}

export async function runStatus(overrides: Partial<StatusDeps> = {}, options: { json?: boolean } = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const autoSync = await deps.autoSync();
  const report = await buildReport(deps, autoSync);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, autoSync);
  return 0;
}

function printReport(report: StatusReport, autoSync: AutoSyncHealth): void {
  const { github, machine, gists } = report;
  console.log(`version: ${report.version}`);
  console.log(`github:  ${github ? `@${github.login} (${github.auth === 'gh' ? 'via gh' : 'tokengraph login'})` : 'not logged in'}`);
  console.log(`machine: ${machine ? `${machine.id} (${machine.label})` : 'not set yet (set on first publish)'}`);
  if (report.lastPublish) console.log(`last publish: ${new Date(report.lastPublish).toLocaleString()}`);
  if (gists.graph) console.log(`graph:   ${gists.graph}`);
  if (gists.data) console.log(`data:    ${gists.data} (secret)`);
  if (report.otherMachines.length > 0) {
    console.log('other machines (as of the last publish):');
    for (const other of report.otherMachines) console.log(`  ${other.label}  updated ${other.updatedAt.slice(0, 10)}  ${other.activeDays} days`);
  }
  console.log(`ledger:  ${report.ledger.activeDays} active days in ${report.ledger.path}`);
  for (const [source, count] of Object.entries(report.ledger.sources)) console.log(`  ${source}: ${count} days`);
  for (const day of report.ledger.recentDays) console.log(`  ${day.date}  ${formatTokens(day.weighted).padStart(8)}`);
  printAutoSync(autoSync);
  printRetention(report.retention, report.warnings);
  if (report.lastHookSync) {
    console.log(`last hook sync: ${report.lastHookSync.at} (${hookSyncLogPath()})`);
    if (report.lastHookSync.error) console.log(`  ${report.lastHookSync.error}`);
  }
  if (report.legacyData.length > 0) {
    console.log(`\nnote: data from an older version was not moved to ${configHome()}:`);
    for (const path of report.legacyData) console.log(`  ${path}`);
    console.log('  It is not read any more. Keep it until you have checked your totals, then merge or delete it by hand.');
  }
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
  const what = policy.source === 'gemini-cli' ? 'sessions' : policy.source === 'qwen-code' ? 'background subagent transcripts' : 'transcripts';
  return `deletes ${what} after ${formatDays(policy.days ?? 0)} (${policy.isDefault ? 'default; ' : ''}${where})`;
}

function printRetention(policies: RetentionPolicy[], warnings: string[]): void {
  if (policies.length === 0) return;
  console.log('data retention:');
  for (const policy of policies) console.log(`  ${`${policy.source}:`.padEnd(18)}${retentionLine(policy)}`);
  for (const warning of warnings) console.log(`warning: ${warning}`);
}
