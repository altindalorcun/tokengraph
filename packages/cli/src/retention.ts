import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KnownSource } from '@tokengraph/core';
import { projectsDir } from './adapters/claude-code/index.js';
import { geminiTmpDirs } from './adapters/gemini-cli/index.js';
import { qwenProjectsDirs, qwenSettingsPath } from './adapters/qwen-code/index.js';
import type { AutoSyncEntry, AutoSyncHealth } from './auto-sync-health.js';
import { settingsPath as claudeSettingsPath } from './commands/install-hook.js';

/** How long one agent keeps its own logs, as read from that agent's settings file. */
export interface RetentionPolicy {
  source: KnownSource;
  /** Days the agent keeps its logs; null when it keeps them forever (`keeps`) or the setting is unreadable (`unknown`). */
  days: number | null;
  /** True when the setting is absent and the agent's built-in default applies. */
  isDefault: boolean;
  /** The setting's name as the user writes it. */
  setting: string;
  configPath: string;
  state: 'deletes' | 'keeps' | 'unknown';
}

export interface RetentionDeps {
  claudeSettingsPath: () => string;
  claudeDataDirs: () => string[];
  geminiSettingsPath: () => string;
  geminiDataDirs: () => string[];
  qwenSettingsPath: () => string;
  qwenDataDirs: () => string[];
  /** The file's text, or null when it does not exist or cannot be read. */
  readText: (path: string) => Promise<string | null>;
  isDirectory: (path: string) => Promise<boolean>;
}

const DEFAULT_DEPS: RetentionDeps = {
  claudeSettingsPath,
  claudeDataDirs: () => [projectsDir()],
  geminiSettingsPath: () => join(process.env['GEMINI_CLI_HOME'] ?? homedir(), '.gemini', 'settings.json'),
  geminiDataDirs: geminiTmpDirs,
  qwenSettingsPath,
  qwenDataDirs: qwenProjectsDirs,
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  isDirectory: async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

const CLAUDE_SETTING = 'cleanupPeriodDays';
const GEMINI_SETTING = 'general.sessionRetention';
const QWEN_SETTING = 'general.cleanupPeriodDays';
const DEFAULT_DAYS = 30;

async function anyDirectory(deps: RetentionDeps, paths: string[]): Promise<boolean> {
  for (const path of paths) if (await deps.isDirectory(path)) return true;
  return false;
}

/** The parsed settings object, `undefined` when the file is missing, null when it is not a JSON object. */
async function readSettings(deps: RetentionDeps, path: string): Promise<Record<string, unknown> | null | undefined> {
  const text = await deps.readText(path);
  if (text === null) return undefined;
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function claudePolicy(settings: Record<string, unknown> | null | undefined, configPath: string): RetentionPolicy {
  const base = { source: 'claude-code' as const, setting: CLAUDE_SETTING, configPath };
  if (settings === null) return { ...base, days: null, isDefault: false, state: 'unknown' };
  const value = settings?.[CLAUDE_SETTING];
  if (value === undefined) return { ...base, days: DEFAULT_DAYS, isDefault: true, state: 'deletes' };
  // Claude Code keeps transcripts for `cleanupPeriodDays` days (default 30) and deletes older ones in a background
  // sweep after a session starts. A whole number, minimum 1; 0 is rejected as a validation error, so it is not a policy.
  // https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically
  // https://code.claude.com/docs/en/settings-reference#cleanupperioddays
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return { ...base, days: null, isDefault: false, state: 'unknown' };
  return { ...base, days: value, isDefault: false, state: 'deletes' };
}

/**
 * Gemini CLI's `maxAge` is `<number><unit>` with unit h, d, w or m (a month is 30 days) and a value above 0
 * (parseRetentionPeriod in packages/cli/src/utils/sessionCleanup.ts, see docs/agents/gemini-cli-usage.md).
 */
function parseMaxAgeDays(maxAge: string): number | null {
  const match = /^(\d+)([dhwm])$/.exec(maxAge);
  if (!match) return null;
  const value = Number(match[1]);
  if (value === 0) return null;
  const perUnit = { h: 1 / 24, d: 1, w: 7, m: 30 }[match[2] as 'h' | 'd' | 'w' | 'm'];
  return value * perUnit;
}

function geminiPolicy(settings: Record<string, unknown> | null | undefined, configPath: string): RetentionPolicy {
  const base = { source: 'gemini-cli' as const, setting: GEMINI_SETTING, configPath };
  const unknown: RetentionPolicy = { ...base, days: null, isDefault: false, state: 'unknown' };
  if (settings === null) return unknown;
  const general = settings?.['general'];
  const retention = typeof general === 'object' && general !== null ? (general as Record<string, unknown>)['sessionRetention'] : undefined;
  if (retention === undefined) return { ...base, days: DEFAULT_DAYS, isDefault: true, state: 'deletes' };
  if (typeof retention !== 'object' || retention === null || Array.isArray(retention)) return unknown;
  const { enabled, maxAge } = retention as Record<string, unknown>;
  if (enabled !== undefined && typeof enabled !== 'boolean') return unknown;
  if (enabled === false) return { ...base, days: null, isDefault: false, state: 'keeps' };
  if (maxAge === undefined) return { ...base, days: DEFAULT_DAYS, isDefault: enabled === undefined, state: 'deletes' };
  const days = typeof maxAge === 'string' ? parseMaxAgeDays(maxAge) : null;
  return days === null ? unknown : { ...base, days, isDefault: false, state: 'deletes' };
}

/**
 * Qwen Code keeps chat transcripts (`projects/<cwd>/chats/`) for good. What its background sweep deletes, after
 * `general.cleanupPeriodDays` days (default 30, by the folder's modification time), is the background subagents'
 * transcripts under `projects/<cwd>/subagents/<session>/`, so only that usage is at risk. A value of 0 or below
 * keeps just the last hour. Only the user settings file is read, not a project's `.qwen/settings.json`.
 * https://github.com/QwenLM/qwen-code/blob/e584d4d1973a/packages/cli/src/utils/housekeeping/cleanup.ts
 */
function qwenPolicy(settings: Record<string, unknown> | null | undefined, configPath: string): RetentionPolicy {
  const base = { source: 'qwen-code' as const, setting: QWEN_SETTING, configPath };
  if (settings === null) return { ...base, days: null, isDefault: false, state: 'unknown' };
  const general = settings?.['general'];
  const value = typeof general === 'object' && general !== null ? (general as Record<string, unknown>)['cleanupPeriodDays'] : undefined;
  if (value === undefined) return { ...base, days: DEFAULT_DAYS, isDefault: true, state: 'deletes' };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ...base, days: null, isDefault: false, state: 'unknown' };
  return { ...base, days: value > 0 ? value : 1 / 24, isDefault: false, state: 'deletes' };
}

/** The auto-deletion policy of every agent that is installed here and deletes its own logs (Claude Code, Gemini CLI, Qwen Code). */
export async function readRetentionPolicies(overrides: Partial<RetentionDeps> = {}): Promise<RetentionPolicy[]> {
  const deps: RetentionDeps = { ...DEFAULT_DEPS, ...overrides };
  const policies: RetentionPolicy[] = [];
  if (await anyDirectory(deps, deps.claudeDataDirs())) {
    const path = deps.claudeSettingsPath();
    policies.push(claudePolicy(await readSettings(deps, path), path));
  }
  if (await anyDirectory(deps, deps.geminiDataDirs())) {
    const path = deps.geminiSettingsPath();
    policies.push(geminiPolicy(await readSettings(deps, path), path));
  }
  if (await anyDirectory(deps, deps.qwenDataDirs())) {
    const path = deps.qwenSettingsPath();
    policies.push(qwenPolicy(await readSettings(deps, path), path));
  }
  return policies;
}

const healthy = (entry: AutoSyncEntry): boolean => entry.installed === true && entry.missing.length === 0;

/** Plain sentences for the policies that put history at risk. Data only: the caller prints them. */
export function retentionWarnings(policies: RetentionPolicy[], autoSync: AutoSyncHealth): string[] {
  const warnings: string[] = [];
  for (const policy of policies) {
    if (policy.state !== 'deletes' || policy.days === null) continue;
    const covered = policy.source === 'claude-code' ? healthy(autoSync.claudeHook) || healthy(autoSync.schedule) : healthy(autoSync.schedule);
    const days = formatDays(policy.days);
    const logs = policy.source === 'qwen-code' ? 'background subagent logs' : 'logs';
    const where = `${policy.setting} in ${policy.configPath}`;
    if (!covered) {
      warnings.push(
        `${policy.source} deletes its ${logs} after ${days} and no working background sync reads them first, so usage older than that is lost. Run \`tokengraph schedule\` or raise ${where}.`,
      );
    }
    if (policy.days < 7) {
      warnings.push(`${policy.source} deletes its ${logs} after only ${days} (${where}). Raise it to at least 7 days, or sync more often with \`tokengraph schedule\`.`);
    }
  }
  return warnings;
}

export function formatDays(days: number): string {
  const text = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${text} ${days === 1 ? 'day' : 'days'}`;
}
