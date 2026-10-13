import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexConfigPath, codexNotifyArgs } from '../src/codex-config-toml.js';
import { runInstallHook } from '../src/commands/install-hook.js';

describe('install-hook --agent codex', () => {
  const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], CODEX_HOME: process.env['CODEX_HOME'] };
  let home: string;
  let log: ReturnType<typeof vi.spyOn>;

  const restore = (key: keyof typeof saved) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    process.env['CODEX_HOME'] = join(home, '.codex');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    restore('HOME');
    restore('USERPROFILE');
    restore('CODEX_HOME');
    vi.restoreAllMocks();
  });

  const options = (overrides = {}) => ({ agent: 'codex' as const, event: 'SessionEnd', remove: false, dryRun: false, ...overrides });
  const output = () => log.mock.calls.map((call) => call.join(' ')).join('\n');
  const ours = () => `notify = [${codexNotifyArgs().map((a) => JSON.stringify(a)).join(', ')}]`;

  it('resolves config.toml under CODEX_HOME and runs hook-sync with a 10 minute floor', () => {
    expect(codexConfigPath()).toBe(join(home, '.codex', 'config.toml'));
    expect(codexNotifyArgs().slice(2)).toEqual(['hook-sync', '--min-interval', '600']);
    delete process.env['CODEX_HOME'];
    expect(codexConfigPath()).toBe(join(home, '.codex', 'config.toml'));
  });

  it('creates config.toml with our notify when there is none', async () => {
    expect(await runInstallHook(options())).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(`${ours()}\n`);
    expect(output()).toContain('Installed the tokengraph Codex hook (notify).');
    expect(output()).toContain(`config: ${codexConfigPath()}`);
  });

  it('writes our notify above the existing content and backs the file up', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    const existing = 'model = "o3"\n\n[profiles.work]\nnotify = ["say"]\n';
    await writeFile(codexConfigPath(), existing);
    expect(await runInstallHook(options())).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(`${ours()}\n${existing}`);
    expect(await readFile(`${codexConfigPath()}.tokengraph.bak`, 'utf8')).toBe(existing);
  });

  it('is a no-op the second time', async () => {
    await runInstallHook(options());
    log.mockClear();
    expect(await runInstallHook(options())).toBe(0);
    expect(output()).toContain('already installed');
  });

  it('leaves a foreign notify alone and fails, pointing at schedule', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    const existing = 'notify = ["python3", "/me/notify.py"]\n';
    await writeFile(codexConfigPath(), existing);
    expect(await runInstallHook(options())).toBe(1);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(existing);
    await expect(readFile(`${codexConfigPath()}.tokengraph.bak`, 'utf8')).rejects.toThrow();
    expect(output()).toContain('tokengraph schedule');
    expect(output()).toContain('notify = ["python3", "/me/notify.py"]');
  });

  it('does not write on a dry run', async () => {
    expect(await runInstallHook(options({ dryRun: true }))).toBe(0);
    await expect(readFile(codexConfigPath(), 'utf8')).rejects.toThrow();
    expect(output()).toContain(ours());
  });

  it('removes our notify and leaves the rest', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(codexConfigPath(), 'model = "o3"\n');
    await runInstallHook(options());
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe('model = "o3"\n');
  });

  it('does not remove a foreign notify', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    const existing = 'notify = ["say"]\n';
    await writeFile(codexConfigPath(), existing);
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(existing);
  });
});
