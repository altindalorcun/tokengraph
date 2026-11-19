import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { installStatusline, removeStatusline, setClaudeLimits, statuslineInstalled } from '../src/claude-statusline.js';
import { readConfig, writeConfig } from '../src/config.js';

const OURS = '"/usr/local/bin/node" "/usr/local/lib/node_modules/tokengraph/bundle/bin.js" statusline';
const USERS = { type: 'command', command: 'bash ~/.claude/statusline-command.sh', padding: 1 };

describe('installStatusline', () => {
  it('adds ours when there is no status line', () => {
    expect(installStatusline({ model: 'opus' }, OURS, null)).toEqual({
      settings: { model: 'opus', statusLine: { type: 'command', command: OURS } },
      previous: null,
    });
  });

  it("wraps someone else's status line and keeps its other fields", () => {
    expect(installStatusline({ statusLine: USERS }, OURS, null)).toEqual({
      settings: { statusLine: { type: 'command', command: OURS, padding: 1 } },
      previous: USERS,
    });
  });

  it('install when already ours keeps previous', () => {
    const settings = { statusLine: { type: 'command', command: OURS, padding: 1 } };
    expect(installStatusline(settings, OURS, USERS)).toEqual({ settings, previous: USERS });
  });

  it('refuses a status line it cannot read', () => {
    expect(installStatusline({ statusLine: 'bash x' }, OURS, null)).toHaveProperty('refusal');
    expect(installStatusline({ statusLine: { type: 'command' } }, OURS, null)).toHaveProperty('refusal');
  });
});

describe('removeStatusline', () => {
  it('writes the previous status line back exactly', () => {
    expect(removeStatusline({ statusLine: { type: 'command', command: OURS, padding: 1 } }, USERS)).toEqual({ settings: { statusLine: USERS } });
  });

  it('deletes ours when there was none before', () => {
    expect(removeStatusline({ model: 'opus', statusLine: { type: 'command', command: OURS } }, null)).toEqual({ settings: { model: 'opus' } });
  });

  it('leaves a status line that is no longer ours, and says when there is none', () => {
    expect(removeStatusline({ statusLine: USERS }, null)).toEqual({ untouched: 'not-ours' });
    expect(removeStatusline({}, USERS)).toEqual({ untouched: 'absent' });
  });

  it('round-trips the user status line', () => {
    const installed = installStatusline({ statusLine: USERS, other: [1, 2] }, OURS, null);
    if ('refusal' in installed) throw new Error('refused');
    expect(removeStatusline(installed.settings, installed.previous)).toStrictEqual({ settings: { statusLine: USERS, other: [1, 2] } });
  });

  it('statuslineInstalled is true only for ours', () => {
    expect(statuslineInstalled({ statusLine: { type: 'command', command: OURS } })).toBe(true);
    expect(statuslineInstalled({ statusLine: USERS })).toBe(false);
    expect(statuslineInstalled({})).toBe(false);
  });
});

describe('setClaudeLimits', () => {
  let dir: string;
  let settingsPath: string;
  let configPath: string;
  const paths = () => ({ settingsPath, configPath, command: OURS, bin: '/usr/local/lib/node_modules/tokengraph/bundle/bin.js' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-statusline-'));
    settingsPath = join(dir, 'claude', 'settings.json');
    configPath = join(dir, 'tokengraph', 'config.json');
  });

  it('wraps the status line, stores the old one, and puts it back', async () => {
    await writeConfig({}, configPath);
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'claude'), { recursive: true }));
    await writeFile(settingsPath, JSON.stringify({ statusLine: USERS }));

    expect((await setClaudeLimits(true, paths())).code).toBe(0);
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).statusLine.command).toBe(OURS);
    expect((await readConfig(configPath)).claudeStatusline).toEqual({ previous: USERS });

    expect((await setClaudeLimits(false, paths())).code).toBe(0);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ statusLine: USERS });
    expect((await readConfig(configPath)).claudeStatusline).toBeUndefined();
  });

  it('refuses settings that are not a JSON object and writes nothing', async () => {
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'claude'), { recursive: true }));
    await writeFile(settingsPath, '[]');
    const result = await setClaudeLimits(true, paths());
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/settings\.json/);
    expect(await readFile(settingsPath, 'utf8')).toBe('[]');
    expect(existsSync(configPath)).toBe(false);
  });

  it('turning off with nothing installed says so and succeeds', async () => {
    const result = await setClaudeLimits(false, paths());
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/not installed/);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('turning off after the user replaced ours leaves their setting', async () => {
    await writeConfig({ claudeStatusline: { previous: null } }, configPath);
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'claude'), { recursive: true }));
    await writeFile(settingsPath, JSON.stringify({ statusLine: USERS }));
    const result = await setClaudeLimits(false, paths());
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/no longer/);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ statusLine: USERS });
    expect((await readConfig(configPath)).claudeStatusline).toBeUndefined();
  });

  it('refuses to install from a temporary package cache', async () => {
    const result = await setClaudeLimits(true, { ...paths(), bin: '/Users/a/.npm/_npx/123/node_modules/tokengraph/bundle/bin.js' });
    expect(result.code).toBe(1);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('a dry run changes nothing', async () => {
    const result = await setClaudeLimits(true, { ...paths(), dryRun: true });
    expect(result.code).toBe(0);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });
});
