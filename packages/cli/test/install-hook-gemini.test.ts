import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectAutoSync } from '../src/auto-sync-health.js';
import { geminiHookCommand, geminiSettingsPath, runInstallHook } from '../src/commands/install-hook.js';
import { detectAutoSync } from '../src/tui/auto-sync.js';

describe('install-hook --agent gemini-cli', () => {
  const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], GEMINI_CLI_HOME: process.env['GEMINI_CLI_HOME'] };
  let home: string;
  let log: ReturnType<typeof vi.spyOn>;

  const restore = (key: keyof typeof saved) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gemini-home-'));
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    delete process.env['GEMINI_CLI_HOME'];
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    restore('HOME');
    restore('USERPROFILE');
    restore('GEMINI_CLI_HOME');
    vi.restoreAllMocks();
  });

  const options = (overrides = {}) => ({ agent: 'gemini-cli' as const, event: 'SessionEnd', remove: false, dryRun: false, ...overrides });
  const output = () => log.mock.calls.map((call) => call.join(' ')).join('\n');
  const read = async () => JSON.parse(await readFile(geminiSettingsPath(), 'utf8')) as Record<string, any>;
  const ours = () => ({ name: 'tokengraph', type: 'command', command: geminiHookCommand(), timeout: 5000 });
  const foreign = { matcher: 'exit', hooks: [{ name: 'mine', type: 'command', command: 'echo bye' }] };

  it('creates settings.json with a SessionEnd hook and no matcher', async () => {
    expect(geminiSettingsPath()).toBe(join(home, '.gemini', 'settings.json'));
    expect(await runInstallHook(options())).toBe(0);
    expect(await read()).toEqual({ hooks: { SessionEnd: [{ hooks: [ours()] }] } });
    expect(output()).toContain('Installed the tokengraph Gemini CLI hook');
  });

  it('keeps foreign hooks, other events and unknown keys, and backs the file up', async () => {
    await mkdir(join(home, '.gemini'), { recursive: true });
    const existing = {
      security: { auth: { selectedType: 'oauth-personal' } },
      hooksConfig: { enabled: true, custom: 1 },
      hooks: { SessionEnd: [foreign], BeforeTool: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'audit' }] }] },
      somethingNew: [1, 2],
    };
    await writeFile(geminiSettingsPath(), JSON.stringify(existing, null, 2));
    expect(await runInstallHook(options())).toBe(0);
    const after = await read();
    expect(after).toEqual({ ...existing, hooks: { ...existing.hooks, SessionEnd: [foreign, { hooks: [ours()] }] } });
    expect(JSON.parse(await readFile(`${geminiSettingsPath()}.tokengraph.bak`, 'utf8'))).toEqual(existing);
  });

  it('is idempotent', async () => {
    await runInstallHook(options());
    const first = await readFile(geminiSettingsPath(), 'utf8');
    log.mockClear();
    expect(await runInstallHook(options())).toBe(0);
    expect(output()).toContain('already installed');
    expect(await readFile(geminiSettingsPath(), 'utf8')).toBe(first);
  });

  it('replaces an older tokengraph command instead of adding a second hook', async () => {
    await mkdir(join(home, '.gemini'), { recursive: true });
    const old = '"/old/node" "/old/node_modules/tokengraph/dist/bin.js" hook-sync';
    await writeFile(geminiSettingsPath(), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: old }] }] } }));
    expect(await runInstallHook(options())).toBe(0);
    expect((await read())['hooks'].SessionEnd).toEqual([{ hooks: [ours()] }]);
    expect(output()).toContain('replaced an older command');
  });

  it('--remove deletes only ours', async () => {
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(geminiSettingsPath(), JSON.stringify({ theme: 'dark', hooks: { SessionEnd: [foreign] } }));
    await runInstallHook(options());
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(await read()).toEqual({ theme: 'dark', hooks: { SessionEnd: [foreign] } });
    log.mockClear();
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(output()).toContain('Nothing to do');
  });

  it('--remove drops the empty hooks key it created', async () => {
    await runInstallHook(options());
    await runInstallHook(options({ remove: true }));
    expect(await read()).toEqual({});
  });

  it('--dry-run prints the result and writes nothing', async () => {
    expect(await runInstallHook(options({ dryRun: true }))).toBe(0);
    await expect(readFile(geminiSettingsPath(), 'utf8')).rejects.toThrow();
    expect(output()).toContain('Would write');
    expect(output()).toContain('hook-sync');
  });

  it('respects GEMINI_CLI_HOME', async () => {
    const other = join(home, 'elsewhere');
    process.env['GEMINI_CLI_HOME'] = other;
    expect(await runInstallHook(options())).toBe(0);
    expect(geminiSettingsPath()).toBe(join(other, '.gemini', 'settings.json'));
    expect((await read())['hooks'].SessionEnd).toHaveLength(1);
    await expect(readFile(join(home, '.gemini', 'settings.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses a settings file that is not plain JSON and leaves it alone', async () => {
    await mkdir(join(home, '.gemini'), { recursive: true });
    const text = '{\n  // my notes\n  "theme": "dark"\n}\n';
    await writeFile(geminiSettingsPath(), text);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runInstallHook(options())).toBe(1);
    expect(error).toHaveBeenCalled();
    expect(await readFile(geminiSettingsPath(), 'utf8')).toBe(text);
  });

  it('warns when hooks are switched off in settings', async () => {
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(geminiSettingsPath(), JSON.stringify({ hooksConfig: { enabled: false } }));
    await runInstallHook(options());
    expect(output()).toContain('hooksConfig.enabled is false');
  });

  describe('status', () => {
    const NODE = '/usr/local/bin/node';
    const BIN = '/usr/local/lib/node_modules/tokengraph/bundle/bin.js';
    const settings = (command: string) => JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command }] }] } });
    const deps = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}) => ({
      platform: 'darwin' as const,
      home: () => '/home/me',
      env,
      readText: async (p: string) => files[p.replace(/\\/g, '/')] ?? null,
      exists: async (p: string) => p.replace(/\\/g, '/') in files,
      crontab: async () => null,
    });

    it('reports installed and healthy', async () => {
      const files = { '/home/me/.gemini/settings.json': settings(`"${NODE}" "${BIN}" hook-sync`), [NODE]: '', [BIN]: '' };
      expect((await inspectAutoSync(deps(files))).geminiHook).toEqual({ installed: true, detail: 'SessionEnd', missing: [] });
      expect((await detectAutoSync(deps(files))).geminiHook).toBe(true);
    });

    it('reports the stored paths that are gone', async () => {
      const files = { '/home/me/.gemini/settings.json': settings(`"${NODE}" "${BIN}" hook-sync`), [NODE]: '' };
      expect((await inspectAutoSync(deps(files))).geminiHook.missing).toEqual([BIN]);
    });

    it('follows GEMINI_CLI_HOME, recognises the Windows form, and ignores foreign hooks', async () => {
      const files = { '/g/.gemini/settings.json': settings(`& "${NODE}" "${BIN}" hook-sync`), [NODE]: '', [BIN]: '' };
      expect((await inspectAutoSync(deps(files, { GEMINI_CLI_HOME: '/g' }))).geminiHook.installed).toBe(true);
      const other = { '/home/me/.gemini/settings.json': settings('echo hi') };
      expect((await inspectAutoSync(deps(other))).geminiHook.installed).toBe(false);
      expect((await detectAutoSync(deps({}))).geminiHook).toBe(false);
    });
  });
});
