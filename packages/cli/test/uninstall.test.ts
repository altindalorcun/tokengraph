import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUninstall, type UninstallDeps } from '../src/commands/uninstall.js';

describe('tokengraph uninstall', () => {
  let out: string;
  let err: string;
  let root: string;
  let home: string;
  let data: string;
  let hooks: Array<[string, boolean]>;
  let schedules: boolean[];
  let removeDir: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;

  function deps(extra: Partial<UninstallDeps> = {}): Partial<UninstallDeps> {
    return {
      removeHook: async (agent, dryRun) => {
        hooks.push([agent, dryRun]);
        return 0;
      },
      removeSchedule: async (dryRun) => {
        schedules.push(dryRun);
        return 0;
      },
      readConfig: async () => ({}),
      dataHome: () => data,
      userHome: () => home,
      isTty: () => false,
      confirm: async () => true,
      removeDir,
      ...extra,
    };
  }

  beforeEach(async () => {
    out = '';
    err = '';
    hooks = [];
    schedules = [];
    root = await mkdtemp(join(tmpdir(), 'tokengraph-uninstall-'));
    home = join(root, 'home');
    data = join(home, '.tokengraph');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'config.json'), '{}');
    await writeFile(join(data, 'cursor-events.jsonl'), '');
    removeDir = vi.fn((path: string) => rm(path, { recursive: true, force: true }));
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void (out += `${args.join(' ')}\n`));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void (err += `${args.join(' ')}\n`));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('removes the three hooks and the schedule, keeps the data, and names the npm command', async () => {
    expect(await runUninstall({ purge: false, yes: false, dryRun: false }, deps())).toBe(0);
    expect(hooks).toEqual([['claude-code', false], ['cursor', false], ['codex', false]]);
    expect(schedules).toEqual([false]);
    expect(existsSync(data)).toBe(true);
    expect(out).toContain('To remove the program too: npm uninstall -g tokengraph');
  });

  it('dry-run passes dryRun to every remover and deletes nothing, even with --purge', async () => {
    expect(await runUninstall({ purge: true, yes: false, dryRun: true }, deps())).toBe(0);
    expect(hooks.every(([, dry]) => dry)).toBe(true);
    expect(hooks).toHaveLength(3);
    expect(schedules).toEqual([true]);
    expect(removeDir).not.toHaveBeenCalled();
    expect(existsSync(data)).toBe(true);
    expect(out).toContain('cursor-events.jsonl');
  });

  it('runs every remover when one fails and exits 1', async () => {
    const code = await runUninstall(
      { purge: false, yes: false, dryRun: false },
      deps({
        removeHook: async (agent) => {
          hooks.push([agent, false]);
          return agent === 'claude-code' ? 1 : 0;
        },
      }),
    );
    expect(code).toBe(1);
    expect(hooks).toHaveLength(3);
    expect(schedules).toEqual([false]);
  });

  it('purge without a terminal and without --yes refuses before changing anything', async () => {
    expect(await runUninstall({ purge: true, yes: false, dryRun: false }, deps())).toBe(1);
    expect(err).toContain('--yes');
    expect(hooks).toEqual([]);
    expect(existsSync(data)).toBe(true);
  });

  it('purge with --yes deletes the data folder and prints the gist URLs', async () => {
    const config = {
      github: { login: 'octo', auth: { kind: 'gh' as const, ghPath: 'gh' } },
      gists: { graph: 'a'.repeat(32), data: 'b'.repeat(32) },
    };
    expect(await runUninstall({ purge: true, yes: true, dryRun: false }, deps({ readConfig: async () => config }))).toBe(0);
    expect(existsSync(data)).toBe(false);
    expect(out).toContain(`https://gist.github.com/octo/${'a'.repeat(32)}`);
    expect(out).toContain(`https://gist.github.com/octo/${'b'.repeat(32)}`);
    expect(out).toContain('https://gist.github.com');
    expect(out).toContain('only copy of your Cursor usage');
  });

  it('in a terminal, a "no" keeps the data', async () => {
    const confirm = vi.fn(async () => false);
    expect(await runUninstall({ purge: true, yes: false, dryRun: false }, deps({ isTty: () => true, confirm }))).toBe(0);
    expect(confirm).toHaveBeenCalled();
    expect(existsSync(data)).toBe(true);
  });

  it('refuses to purge the home directory, a root, a foreign folder and a symlink to home', async () => {
    await writeFile(join(home, 'config.json'), '{}'); // even with a marker file, home is refused
    const link = join(root, 'link');
    await symlink(home, link);
    const foreign = join(root, 'foreign');
    await mkdir(foreign);
    await writeFile(join(foreign, 'notes.txt'), 'mine');
    const root_ = process.platform === 'win32' ? 'C:\\' : '/';
    for (const dir of [home, root_, foreign, link]) {
      err = '';
      const code = await runUninstall({ purge: true, yes: true, dryRun: false }, deps({ dataHome: () => dir }));
      expect(code, dir).toBe(1);
      expect(err, dir).toContain('Refusing to delete');
    }
    expect(removeDir).not.toHaveBeenCalled();
    expect(await readdir(foreign)).toEqual(['notes.txt']);
    expect(existsSync(join(home, 'config.json'))).toBe(true);
  });

  it('a purge of a folder that does not exist is a no-op', async () => {
    expect(await runUninstall({ purge: true, yes: true, dryRun: false }, deps({ dataHome: () => join(root, 'nope') }))).toBe(0);
    expect(removeDir).not.toHaveBeenCalled();
  });
});
