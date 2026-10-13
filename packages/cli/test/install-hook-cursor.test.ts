import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cursorHookCommand, cursorHooksPath, runInstallHook } from '../src/commands/install-hook.js';

describe('install-hook --agent cursor', () => {
  const savedHome = process.env['HOME'];
  const savedUserProfile = process.env['USERPROFILE'];
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cursor-home-'));
    process.env['HOME'] = home;
    // os.homedir() reads USERPROFILE on Windows, not HOME — keep both pointed at the temp dir.
    process.env['USERPROFILE'] = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env['HOME'] = savedHome;
    process.env['USERPROFILE'] = savedUserProfile;
    vi.restoreAllMocks();
  });

  const options = (overrides = {}) => ({ agent: 'cursor' as const, event: 'SessionEnd', remove: false, dryRun: false, ...overrides });

  it('writes ~/.cursor/hooks.json with a stop hook that runs cursor-hook', async () => {
    expect(await runInstallHook(options())).toBe(0);
    expect(cursorHooksPath()).toBe(join(home, '.cursor', 'hooks.json'));
    const written = JSON.parse(await readFile(cursorHooksPath(), 'utf8'));
    expect(written).toEqual({ version: 1, hooks: { stop: [{ command: cursorHookCommand() }] } });
    expect(cursorHookCommand()).toMatch(/cursor-hook$/);
  });

  it('keeps existing hooks and backs the file up', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const existing = { version: 1, hooks: { stop: [{ command: 'other-tool' }] } };
    await writeFile(cursorHooksPath(), JSON.stringify(existing));
    await runInstallHook(options());
    const written = JSON.parse(await readFile(cursorHooksPath(), 'utf8'));
    expect(written.hooks.stop).toEqual([{ command: 'other-tool' }, { command: cursorHookCommand() }]);
    expect(JSON.parse(await readFile(`${cursorHooksPath()}.tokengraph.bak`, 'utf8'))).toEqual(existing);
  });

  it('removes the hook again', async () => {
    await runInstallHook(options());
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(JSON.parse(await readFile(cursorHooksPath(), 'utf8'))).toEqual({ version: 1, hooks: {} });
  });

  it('replaces an old-form hook with the current command', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const old = '"/opt/homebrew/Cellar/node/1.0.0/bin/node" "/x/token-graph/packages/cli/dist/bin.js" cursor-hook';
    await writeFile(cursorHooksPath(), JSON.stringify({ version: 1, hooks: { stop: [{ command: old }] } }));
    expect(await runInstallHook(options())).toBe(0);
    expect(JSON.parse(await readFile(cursorHooksPath(), 'utf8')).hooks.stop).toEqual([{ command: cursorHookCommand() }]);
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(JSON.parse(await readFile(cursorHooksPath(), 'utf8'))).toEqual({ version: 1, hooks: {} });
  });

  it('does not write on a dry run', async () => {
    await runInstallHook(options({ dryRun: true }));
    await expect(readFile(cursorHooksPath(), 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite a hooks.json that is not a JSON object', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(cursorHooksPath(), '[1,2]');
    await expect(runInstallHook(options())).rejects.toThrow();
    expect(await readFile(cursorHooksPath(), 'utf8')).toBe('[1,2]');
  });
});
