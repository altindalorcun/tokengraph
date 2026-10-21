import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoSyncEntry, AutoSyncHealth } from '../src/auto-sync-health.js';
import { runStatus } from '../src/commands/status.js';
import { readRetentionPolicies, retentionWarnings, type RetentionPolicy } from '../src/retention.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tokengraph-retention-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const claudeSettings = () => join(root, 'claude', 'settings.json');
const geminiSettings = () => join(root, 'gemini', 'settings.json');
const qwenSettings = () => join(root, 'qwen', 'settings.json');

async function setup(options: { claude?: boolean; gemini?: boolean; qwen?: boolean } = { claude: true, gemini: true }) {
  if (options.claude) await mkdir(join(root, 'claude', 'projects'), { recursive: true });
  if (options.gemini) await mkdir(join(root, 'gemini', 'tmp'), { recursive: true });
  if (options.qwen) await mkdir(join(root, 'qwen', 'projects'), { recursive: true });
  await mkdir(join(root, 'claude'), { recursive: true });
  await mkdir(join(root, 'qwen'), { recursive: true });
  await mkdir(join(root, 'gemini'), { recursive: true });
}

function read() {
  return readRetentionPolicies({
    claudeSettingsPath: claudeSettings,
    claudeDataDirs: () => [join(root, 'claude', 'projects')],
    geminiSettingsPath: geminiSettings,
    geminiDataDirs: () => [join(root, 'gemini', 'tmp')],
    qwenSettingsPath: qwenSettings,
    qwenDataDirs: () => [join(root, 'qwen', 'projects')],
  });
}

async function claude(settings: string | undefined) {
  await setup({ claude: true });
  if (settings !== undefined) await writeFile(claudeSettings(), settings);
  return (await read())[0]!;
}

async function gemini(settings: string | undefined) {
  await setup({ gemini: true });
  if (settings !== undefined) await writeFile(geminiSettings(), settings);
  return (await read())[0]!;
}

async function qwen(settings: string | undefined) {
  await setup({ qwen: true });
  if (settings !== undefined) await writeFile(qwenSettings(), settings);
  return (await read())[0]!;
}

describe('Claude Code retention', () => {
  it('defaults to 30 days when the setting is absent, with or without a settings file', async () => {
    const expected = { source: 'claude-code', days: 30, isDefault: true, setting: 'cleanupPeriodDays', state: 'deletes' };
    expect(await claude(undefined)).toMatchObject({ ...expected, configPath: claudeSettings() });
    expect(await claude('{}')).toMatchObject(expected);
  });

  it('reads an explicit number of days', async () => {
    expect(await claude('{"cleanupPeriodDays": 90}')).toMatchObject({ days: 90, isDefault: false, state: 'deletes' });
  });

  it('treats 0 (a validation error in Claude Code), negatives and fractions as unknown', async () => {
    for (const value of ['0', '-3', '2.5']) {
      expect(await claude(`{"cleanupPeriodDays": ${value}}`)).toMatchObject({ days: null, state: 'unknown' });
    }
  });

  it('treats malformed JSON and non-number values as unknown', async () => {
    for (const text of ['{nope', '[]', '{"cleanupPeriodDays": "30"}', '{"cleanupPeriodDays": null}']) {
      expect(await claude(text)).toMatchObject({ days: null, state: 'unknown' });
    }
  });
});

describe('Gemini CLI retention', () => {
  const setting = 'general.sessionRetention';

  it('defaults to 30 days when nothing is set', async () => {
    expect(await gemini(undefined)).toMatchObject({ source: 'gemini-cli', days: 30, isDefault: true, setting, state: 'deletes', configPath: geminiSettings() });
    expect(await gemini('{"general": {}}')).toMatchObject({ days: 30, isDefault: true });
  });

  it('keeps sessions when retention is disabled', async () => {
    expect(await gemini('{"general": {"sessionRetention": {"enabled": false, "maxAge": "7d"}}}')).toMatchObject({ days: null, state: 'keeps' });
  });

  it('reads maxAge in hours, days, weeks and months', async () => {
    const days = async (maxAge: string) => (await gemini(`{"general": {"sessionRetention": {"enabled": true, "maxAge": "${maxAge}"}}}`)).days;
    expect(await days('90d')).toBe(90);
    expect(await days('2w')).toBe(14);
    expect(await days('3m')).toBe(90);
    expect(await days('48h')).toBe(2);
    expect(await days('12h')).toBe(0.5);
  });

  it('uses the default maxAge when only enabled is given', async () => {
    expect(await gemini('{"general": {"sessionRetention": {"enabled": true}}}')).toMatchObject({ days: 30, isDefault: false, state: 'deletes' });
  });

  it('treats an unparseable maxAge, wrong types and malformed JSON as unknown', async () => {
    for (const text of [
      '{"general": {"sessionRetention": {"maxAge": "0d"}}}',
      '{"general": {"sessionRetention": {"maxAge": "30 days"}}}',
      '{"general": {"sessionRetention": {"maxAge": "1.5d"}}}',
      '{"general": {"sessionRetention": {"maxAge": 30}}}',
      '{"general": {"sessionRetention": {"enabled": "no"}}}',
      '{"general": {"sessionRetention": true}}',
      '{oops',
    ]) {
      expect(await gemini(text)).toMatchObject({ days: null, state: 'unknown' });
    }
  });
});

describe('Qwen Code retention', () => {
  const setting = 'general.cleanupPeriodDays';

  it('defaults to 30 days when nothing is set', async () => {
    expect(await qwen(undefined)).toMatchObject({ source: 'qwen-code', days: 30, isDefault: true, setting, state: 'deletes', configPath: qwenSettings() });
    expect(await qwen('{"general": {}}')).toMatchObject({ days: 30, isDefault: true });
    expect(await qwen('{"cleanupPeriodDays": 2}')).toMatchObject({ days: 30, isDefault: true });
  });

  it('reads an explicit number of days, fractions included', async () => {
    expect(await qwen('{"general": {"cleanupPeriodDays": 90}}')).toMatchObject({ days: 90, isDefault: false, state: 'deletes' });
    expect(await qwen('{"general": {"cleanupPeriodDays": 0.5}}')).toMatchObject({ days: 0.5, state: 'deletes' });
  });

  it('treats 0 and negatives as the one-hour minimum Qwen Code applies', async () => {
    expect(await qwen('{"general": {"cleanupPeriodDays": 0}}')).toMatchObject({ days: 1 / 24, isDefault: false, state: 'deletes' });
    expect(await qwen('{"general": {"cleanupPeriodDays": -5}}')).toMatchObject({ days: 1 / 24, state: 'deletes' });
  });

  it('treats malformed JSON and non-number values as unknown', async () => {
    for (const text of ['{nope', '[]', '{"general": {"cleanupPeriodDays": "30"}}', '{"general": {"cleanupPeriodDays": null}}']) {
      expect(await qwen(text)).toMatchObject({ days: null, state: 'unknown' });
    }
  });

  it('warns that only the background subagent logs are at risk', () => {
    const qw = (overrides: Partial<RetentionPolicy> = {}) =>
      policy({ source: 'qwen-code', setting: 'general.cleanupPeriodDays', configPath: '/h/.qwen/settings.json', ...overrides });
    const [warning] = retentionWarnings([qw()], health({ claudeHook: entry(true) }));
    expect(warning).toContain('qwen-code deletes its background subagent logs after 30 days');
    expect(retentionWarnings([qw()], health({ schedule: entry(true) }))).toEqual([]);
    expect(retentionWarnings([qw({ days: 3 })], health({ schedule: entry(true) }))[0]).toContain('background subagent logs after only 3 days');
  });
});

describe('which agents get a policy', () => {
  it('returns none when no agent data directory exists', async () => {
    await setup({});
    await writeFile(claudeSettings(), '{"cleanupPeriodDays": 3}');
    expect(await read()).toEqual([]);
  });

  it('returns a policy only for the agent whose data directory exists', async () => {
    await setup({ claude: true });
    expect((await read()).map((policy) => policy.source)).toEqual(['claude-code']);
    await rm(join(root, 'claude', 'projects'), { recursive: true });
    await setup({ gemini: true });
    expect((await read()).map((policy) => policy.source)).toEqual(['gemini-cli']);
    await rm(join(root, 'gemini', 'tmp'), { recursive: true });
    await setup({ qwen: true });
    expect((await read()).map((policy) => policy.source)).toEqual(['qwen-code']);
  });
});

const entry = (installed: boolean | null, missing: string[] = []): AutoSyncEntry => ({ installed, missing });
const health = (overrides: Partial<AutoSyncHealth> = {}): AutoSyncHealth => ({
  claudeHook: entry(false),
  cursorHook: entry(false),
  codexNotify: entry(false),
  geminiHook: entry(false),
  schedule: entry(false),
  ...overrides,
});
const policy = (overrides: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  source: 'claude-code',
  days: 30,
  isDefault: true,
  setting: 'cleanupPeriodDays',
  configPath: '/h/.claude/settings.json',
  state: 'deletes',
  ...overrides,
});
const gem = (overrides: Partial<RetentionPolicy> = {}) =>
  policy({ source: 'gemini-cli', setting: 'general.sessionRetention', configPath: '/h/.gemini/settings.json', ...overrides });

describe('retentionWarnings', () => {
  it('warns when nothing syncs a deleting agent, naming agent, days, setting, path and fix', () => {
    const [warning, ...rest] = retentionWarnings([policy()], health());
    expect(rest).toEqual([]);
    for (const part of ['claude-code', '30 days', 'cleanupPeriodDays', '/h/.claude/settings.json', 'tokengraph schedule']) expect(warning).toContain(part);
  });

  it('accepts a healthy Claude hook or schedule for Claude Code', () => {
    expect(retentionWarnings([policy()], health({ claudeHook: entry(true) }))).toEqual([]);
    expect(retentionWarnings([policy()], health({ schedule: entry(true) }))).toEqual([]);
  });

  it('does not count a broken or unknown mechanism as coverage', () => {
    expect(retentionWarnings([policy()], health({ claudeHook: entry(true, ['/gone']) }))).toHaveLength(1);
    expect(retentionWarnings([policy()], health({ schedule: entry(null) }))).toHaveLength(1);
  });

  it('covers Gemini CLI only with the schedule', () => {
    expect(retentionWarnings([gem()], health({ claudeHook: entry(true), codexNotify: entry(true) }))).toHaveLength(1);
    expect(retentionWarnings([gem()], health({ schedule: entry(true, ['/gone']) }))).toHaveLength(1);
    expect(retentionWarnings([gem()], health({ schedule: entry(true) }))).toEqual([]);
  });

  it('warns about a window under 7 days even when sync is healthy', () => {
    const [warning, ...rest] = retentionWarnings([policy({ days: 3, isDefault: false })], health({ schedule: entry(true) }));
    expect(rest).toEqual([]);
    expect(warning).toContain('3 days');
    expect(warning).toContain('cleanupPeriodDays');
    expect(retentionWarnings([policy({ days: 7 })], health({ schedule: entry(true) }))).toEqual([]);
  });

  it('gives both warnings when unsynced and short', () => {
    expect(retentionWarnings([policy({ days: 2 })], health())).toHaveLength(2);
  });

  it('ignores keeps and unknown policies', () => {
    expect(retentionWarnings([gem({ state: 'keeps', days: null }), policy({ state: 'unknown', days: null })], health())).toEqual([]);
  });
});

describe('status data retention section', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const base = { autoSync: async () => health({ schedule: entry(true) }), legacyData: () => [] as string[] };

  it('prints each policy and the warnings', async () => {
    await runStatus({
      ...base,
      autoSync: async () => health(),
      retention: async () => [policy({ configPath: '/h/.claude/settings.json' }), gem({ state: 'keeps', days: null, isDefault: false, configPath: '/h/.gemini/settings.json' })],
    });
    const at = lines.indexOf('data retention:');
    expect(at).toBeGreaterThan(lines.indexOf('background sync:'));
    expect(lines[at + 1]).toBe('  claude-code:      deletes transcripts after 30 days (default; cleanupPeriodDays in /h/.claude/settings.json)');
    expect(lines[at + 2]).toBe('  gemini-cli:       keeps sessions (general.sessionRetention is off in /h/.gemini/settings.json)');
    expect(lines[at + 3]).toMatch(/^warning: claude-code deletes its logs after 30 days/);
  });

  it('names what Qwen Code deletes', async () => {
    await runStatus({
      ...base,
      retention: async () => [policy({ source: 'qwen-code', setting: 'general.cleanupPeriodDays', configPath: '/h/.qwen/settings.json' })],
    });
    const at = lines.indexOf('data retention:');
    expect(lines[at + 1]).toBe('  qwen-code:        deletes background subagent transcripts after 30 days (default; general.cleanupPeriodDays in /h/.qwen/settings.json)');
  });

  it('prints nothing when no policy applies', async () => {
    await runStatus({ ...base, retention: async () => [] });
    expect(lines.some((line) => line.startsWith('data retention') || line.startsWith('warning:'))).toBe(false);
  });
});
