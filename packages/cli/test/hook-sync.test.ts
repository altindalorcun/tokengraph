import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOOK_WINDOW_DAYS, runHookSync } from '../src/commands/hook-sync.js';
import { runStatus } from '../src/commands/status.js';
import { hookSyncLogPath, hookSyncStampPath } from '../src/paths.js';
import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';

describe('runHookSync', () => {
  const saved = process.env['TOKENGRAPH_HOME'];
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-hooksync-'));
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('spawns a detached sync with the log fd and unrefs it', async () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    const closeLog = vi.fn();
    const code = runHookSync({ spawn, closeLog, binPath: () => '/x/bin.js', now: () => new Date('2026-09-28T12:00:00.000Z') });
    expect(code).toBe(0);
    expect(HOOK_WINDOW_DAYS).toBe(30);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/x/bin.js', 'sync', '--since', '30', '--trigger', 'hook']);
    expect(options['detached']).toBe(true);
    expect(options['windowsHide']).toBe(true);
    const stdio = options['stdio'] as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(closeLog).toHaveBeenCalledWith(stdio[1]);
    expect(await readFile(hookSyncLogPath(), 'utf8')).toBe(
      '[2026-09-28T12:00:00.000Z] hook-sync: starting sync --since 30\n',
    );
  });

  it('skips without spawning or touching the log when the last start is inside the interval', () => {
    const spawn = vi.fn();
    const openLog = vi.fn();
    const writeStamp = vi.fn();
    const now = new Date('2026-10-03T12:00:00Z');
    const code = runHookSync(
      { spawn, openLog, now: () => now, readStamp: () => now.getTime() - 5 * 60_000, writeStamp },
      { minIntervalSeconds: 600 },
    );
    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(openLog).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });

  it('runs and records the start once the interval has passed', () => {
    const spawn = vi.fn(() => ({ unref: () => {} }));
    const writeStamp = vi.fn();
    const now = new Date('2026-10-03T12:00:00Z');
    runHookSync(
      {
        spawn,
        openLog: () => 3,
        closeLog: () => {},
        writeLog: () => {},
        binPath: () => '/x/token-graph/dist/bin.js',
        now: () => now,
        readStamp: () => now.getTime() - 11 * 60_000,
        writeStamp,
      },
      { minIntervalSeconds: 600 },
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(writeStamp).toHaveBeenCalledWith(now.getTime());
  });

  it('runs when there is no stamp yet', () => {
    const spawn = vi.fn(() => ({ unref: () => {} }));
    const writeStamp = vi.fn();
    runHookSync(
      { spawn, openLog: () => 3, closeLog: () => {}, writeLog: () => {}, binPath: () => '/b', readStamp: () => null, writeStamp },
      { minIntervalSeconds: 600 },
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(writeStamp).toHaveBeenCalledOnce();
  });

  it('never throttles without a minimum interval (the Claude Code hook)', () => {
    const spawn = vi.fn(() => ({ unref: () => {} }));
    const now = new Date();
    runHookSync({
      spawn,
      openLog: () => 3,
      closeLog: () => {},
      writeLog: () => {},
      binPath: () => '/b',
      now: () => now,
      readStamp: () => now.getTime(),
      writeStamp: () => {},
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('still returns 0 and spawns when the stamp cannot be read or written', () => {
    const spawn = vi.fn(() => ({ unref: () => {} }));
    const code = runHookSync(
      {
        spawn,
        openLog: () => 3,
        closeLog: () => {},
        writeLog: () => {},
        binPath: () => '/b',
        readStamp: () => {
          throw new Error('EIO');
        },
        writeStamp: () => {
          throw new Error('EROFS');
        },
      },
      { minIntervalSeconds: 600 },
    );
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('persists the stamp on disk with the default deps', async () => {
    const spawn = vi.fn(() => ({ unref: () => {} }));
    const now = new Date('2026-10-03T12:00:00Z');
    const deps = { spawn, closeLog: () => {}, binPath: () => '/b', now: () => now };
    runHookSync(deps, { minIntervalSeconds: 600 });
    expect(await readFile(hookSyncStampPath(), 'utf8')).toBe(String(now.getTime()));
    runHookSync({ ...deps, now: () => new Date(now.getTime() + 60_000) }, { minIntervalSeconds: 600 });
    expect(spawn).toHaveBeenCalledOnce();
    runHookSync({ ...deps, now: () => new Date(now.getTime() + 601_000) }, { minIntervalSeconds: 600 });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('treats a corrupt stamp file as no stamp', async () => {
    await mkdir(join(root, 'tg'), { recursive: true });
    await writeFile(hookSyncStampPath(), 'not a number');
    const spawn = vi.fn(() => ({ unref: () => {} }));
    runHookSync({ spawn, closeLog: () => {}, binPath: () => '/b' }, { minIntervalSeconds: 600 });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("the argv Codex's notify produces parses without throwing and the JSON lands in positionals[1]", () => {
    const json = '{"type":"agent-turn-complete","turn-id":"1","input-messages":["-x"]}';
    const { values, positionals } = parseArgs({
      args: ['hook-sync', '--min-interval', '600', json],
      allowPositionals: true,
      options: { 'min-interval': { type: 'string' } },
    });
    expect(positionals).toEqual(['hook-sync', json]);
    expect(values['min-interval']).toBe('600');
  });

  it('returns 0 and logs when spawn throws', async () => {
    const spawn = vi.fn(() => {
      throw new Error('boom');
    });
    expect(runHookSync({ spawn })).toBe(0);
    expect(await readFile(hookSyncLogPath(), 'utf8')).toContain('hook-sync: error: boom');
  });

  it('returns 0 when the log cannot be opened', () => {
    const spawn = vi.fn();
    expect(
      runHookSync({
        spawn,
        openLog: () => {
          throw new Error('EACCES');
        },
      }),
    ).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('status hook-sync line', () => {
  const saved = { home: process.env['TOKENGRAPH_HOME'] };
  let root: string;
  let lines: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-status-'));
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });
  afterEach(async () => {
    if (saved.home === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved.home;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('prints nothing when there is no log', async () => {
    await runStatus();
    expect(lines.some((l) => l.startsWith('last hook sync'))).toBe(false);
  });

  it('prints the mtime and a trailing error line', async () => {
    await mkdir(join(root, 'tg'), { recursive: true });
    await writeFile(hookSyncLogPath(), 'header\nupload failed: nope\n\n');
    await runStatus();
    expect(lines.some((l) => l.startsWith('last hook sync: ') && l.includes(hookSyncLogPath()))).toBe(true);
    expect(lines).toContain('  upload failed: nope');
  });

  it('omits the error line when the log ends cleanly', async () => {
    await mkdir(join(root, 'tg'), { recursive: true });
    await writeFile(hookSyncLogPath(), 'header\ntotal weighted tokens: 1\n');
    await runStatus();
    expect(lines.filter((l) => l.startsWith('  ')).some((l) => /failed|error/i.test(l))).toBe(false);
  });
});
