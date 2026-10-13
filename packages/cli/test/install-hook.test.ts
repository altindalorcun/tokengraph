import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookCommand, runInstallHook } from '../src/commands/install-hook.js';

describe('install-hook (claude-code)', () => {
  const saved = { dir: process.env['CLAUDE_CONFIG_DIR'], home: process.env['TOKENGRAPH_HOME'] };
  let dir: string;
  let settingsFile: string;
  let out: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-cfg-'));
    settingsFile = join(dir, 'settings.json');
    process.env['CLAUDE_CONFIG_DIR'] = dir;
    process.env['TOKENGRAPH_HOME'] = join(dir, 'tg');
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
  });

  afterEach(() => {
    for (const [key, value] of [['CLAUDE_CONFIG_DIR', saved.dir], ['TOKENGRAPH_HOME', saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  const options = (overrides = {}) => ({ agent: 'claude-code' as const, event: 'SessionEnd', remove: false, dryRun: false, ...overrides });
  const read = async () => JSON.parse(await readFile(settingsFile, 'utf8'));
  const legacy = (event = 'SessionEnd') => ({
    hooks: {
      [event]: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/homebrew/Cellar/node/25.2.1/bin/node" "/x/token-graph/packages/cli/dist/bin.js" sync --since 30 </dev/null >/dev/null 2>&1 &',
            },
          ],
        },
      ],
    },
  });

  it('builds a plain hook-sync command without redirects', () => {
    expect(hookCommand()).toMatch(/^"[^"]+" "[^"]+bin\.js" hook-sync$/);
  });

  it('installs and tells the user where the background sync logs', async () => {
    expect(await runInstallHook(options())).toBe(0);
    expect((await read()).hooks.SessionEnd).toEqual([{ hooks: [{ type: 'command', command: hookCommand() }] }]);
    const text = out.join('\n');
    expect(text).toContain('Installed the tokengraph hook on SessionEnd.');
    expect(text).toContain(join(dir, 'tg', 'hook-sync.log'));
    expect(text).toContain('--event Stop');
  });

  it('replaces an old-form hook and says so', async () => {
    await writeFile(settingsFile, JSON.stringify({ theme: 'dark', ...legacy() }));
    expect(await runInstallHook(options())).toBe(0);
    const written = await read();
    expect(written.theme).toBe('dark');
    expect(written.hooks.SessionEnd).toEqual([{ hooks: [{ type: 'command', command: hookCommand() }] }]);
    expect(out.join('\n')).toContain('Updated the tokengraph hook on SessionEnd (replaced an older command).');
    out.length = 0;
    await runInstallHook(options());
    expect(out.join('\n')).toContain('already installed');
  });

  it('removes an old-form hook', async () => {
    await writeFile(settingsFile, JSON.stringify(legacy()));
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(await read()).toEqual({});
  });

  it('warns about token-graph hooks on other events without removing them', async () => {
    await writeFile(settingsFile, JSON.stringify(legacy('Stop')));
    await runInstallHook(options());
    const written = await read();
    expect(written.hooks.Stop).toEqual(legacy('Stop').hooks.Stop);
    expect(out.join('\n')).toMatch(/also exist on Stop/);
  });

  it('does not write on a dry run', async () => {
    await runInstallHook(options({ dryRun: true }));
    await expect(readFile(settingsFile, 'utf8')).rejects.toThrow();
  });
});
