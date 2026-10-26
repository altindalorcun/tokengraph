import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSchedule, type ScheduleDeps } from '../src/commands/schedule.js';
import { CRON_MARKER } from '../src/schedule-entries.js';

type RunResult = { code: number; stdout: string; stderr: string };
const ok: RunResult = { code: 0, stdout: '', stderr: '' };

function harness(platform: NodeJS.Platform, respond: (command: string, args: string[]) => RunResult = () => ok, installed = true) {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const written = new Map<string, string>();
  const removed: string[] = [];
  const dirs: string[] = [];
  const sleeps: number[] = [];
  const deps: ScheduleDeps = {
    platform,
    run: async (command, args, stdin) => {
      calls.push({ command, args, stdin });
      return respond(command, args);
    },
    writeFile: async (path, text) => void written.set(path, text),
    removeFile: async (path) => void removed.push(path),
    exists: async () => installed,
    ensureDir: async (path) => void dirs.push(path),
    uid: () => 501,
    home: () => '/Users/me',
    sleep: async (ms) => void sleeps.push(ms),
    cronMinute: () => 42,
  };
  return { deps, calls, written, removed, dirs, sleeps };
}

describe('runSchedule', () => {
  let out: string[];
  beforeEach(() => {
    process.env['TOKENGRAPH_HOME'] = '/Users/me/.tokengraph';
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void out.push(parts.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => void out.push(parts.join(' ')));
  });
  afterEach(() => {
    delete process.env['TOKENGRAPH_HOME'];
    vi.restoreAllMocks();
  });

  const plistPath = '/Users/me/Library/LaunchAgents/dev.tokengraph.sync.plist';

  describe('darwin', () => {
    it('writes the plist, boots out any old job, then bootstraps the new one', async () => {
      const h = harness('darwin');
      expect(await runSchedule({ remove: false, dryRun: false }, h.deps)).toBe(0);
      expect(h.written.get(plistPath)).toContain('<integer>3600</integer>');
      expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
        ['launchctl', 'bootout', 'gui/501/dev.tokengraph.sync'],
        ['launchctl', 'bootstrap', 'gui/501', plistPath],
      ]);
      expect(h.dirs).toContain('/Users/me/.tokengraph');
      expect(out.join('\n')).toContain('Scheduled an hourly sync.');
      expect(out.join('\n')).toContain('tokengraph schedule --remove');
      expect(out.join('\n')).toContain('Log: /Users/me/.tokengraph/schedule.log');
    });

    it('retries a bootstrap that fails right after bootout once, after a short wait', async () => {
      let bootstraps = 0;
      const h = harness('darwin', (_c, args) => {
        if (args[0] !== 'bootstrap') return ok;
        bootstraps += 1;
        return bootstraps === 1 ? { code: 5, stdout: '', stderr: 'Bootstrap failed' } : ok;
      });
      expect(await runSchedule({ remove: false, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.map((c) => c.args[0])).toEqual(['bootout', 'bootstrap', 'bootstrap']);
      expect(h.sleeps).toEqual([500]);
      expect(out.join('\n')).toContain('Scheduled an hourly sync.');
    });

    it('ignores a failing bootout but reports a failing bootstrap', async () => {
      const h = harness('darwin', (_c, args) =>
        args[0] === 'bootout' ? { code: 3, stdout: '', stderr: 'not loaded' } : { code: 5, stdout: '', stderr: 'Bootstrap failed' },
      );
      expect(await runSchedule({ remove: false, dryRun: false }, h.deps)).toBe(1);
      expect(out.join('\n')).toContain('Bootstrap failed');
    });

    it('remove boots out and deletes the plist', async () => {
      const h = harness('darwin');
      expect(await runSchedule({ remove: true, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.map((c) => c.args)).toEqual([['bootout', 'gui/501/dev.tokengraph.sync']]);
      expect(h.removed).toEqual([plistPath]);
      expect(out.join('\n')).toContain('Removed the hourly sync.');
    });

    it('dry-run prints the plist and runs and writes nothing', async () => {
      const h = harness('darwin');
      expect(await runSchedule({ remove: false, dryRun: true }, h.deps)).toBe(0);
      expect(h.calls).toEqual([]);
      expect(h.written.size).toBe(0);
      expect(h.dirs).toEqual([]);
      expect(out.join('\n')).toContain('<integer>3600</integer>');
    });

    it('remove --dry-run changes nothing', async () => {
      const h = harness('darwin');
      expect(await runSchedule({ remove: true, dryRun: true }, h.deps)).toBe(0);
      expect(h.calls).toEqual([]);
      expect(h.removed).toEqual([]);
    });

    const notLoaded = (_command: string, args: string[]) => (args[0] === 'print' ? { code: 113, stdout: '', stderr: 'Could not find service' } : ok);

    it('remove with no plist and no loaded job only asks launchd, and says so', async () => {
      const h = harness('darwin', notLoaded, false);
      expect(await runSchedule({ remove: true, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.map((c) => c.args)).toEqual([['print', 'gui/501/dev.tokengraph.sync']]);
      expect(h.removed).toEqual([]);
      expect(out.join('\n')).toContain('No hourly sync is installed');
      expect(out.join('\n')).not.toContain('Removed');
    });

    it('remove --dry-run with no plist does not claim a delete', async () => {
      const h = harness('darwin', notLoaded, false);
      expect(await runSchedule({ remove: true, dryRun: true }, h.deps)).toBe(0);
      expect(out.join('\n')).not.toContain('Would delete');
    });

    it('remove boots out a job still loaded after its plist was deleted by hand', async () => {
      const h = harness('darwin', () => ok, false);
      expect(await runSchedule({ remove: true, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.map((c) => c.args[0])).toEqual(['print', 'bootout']);
      expect(h.removed).toEqual([]);
      expect(out.join('\n')).toContain('Removed the hourly sync.');
    });
  });

  describe('linux', () => {
    const noCrontab = (_c: string, args: string[]): RunResult =>
      args[0] === '-l' ? { code: 1, stdout: '', stderr: 'no crontab for me' } : ok;

    it('treats "no crontab for <user>" as empty and writes only our line', async () => {
      const h = harness('linux', noCrontab);
      expect(await runSchedule({ remove: false, dryRun: false }, h.deps)).toBe(0);
      const write = h.calls.find((c) => c.args[0] === '-');
      expect(write?.command).toBe('crontab');
      expect(write?.stdin?.trim().split('\n')).toHaveLength(1);
      expect(write?.stdin).toMatch(/^42 \* \* \* \* .* sync --since 30 --trigger schedule >> "\/Users\/me\/\.tokengraph\/schedule\.log" 2>&1 # tokengraph-sync\n$/);
      expect(out.join('\n')).toContain('Scheduled an hourly sync.');
      expect(out.join('\n')).toContain('tokengraph schedule --remove');
    });

    it('keeps existing entries and replaces an older tokengraph line', async () => {
      const existing = `0 5 * * * backup\n17 * * * * old ${CRON_MARKER}\n`;
      const h = harness('linux', (_c, args) => (args[0] === '-l' ? { code: 0, stdout: existing, stderr: '' } : ok));
      await runSchedule({ remove: false, dryRun: false }, h.deps);
      const stdin = h.calls.find((c) => c.args[0] === '-')?.stdin ?? '';
      expect(stdin).toContain('0 5 * * * backup\n');
      expect(stdin).not.toContain('old');
      expect(stdin.match(/tokengraph-sync/g)).toHaveLength(1);
    });

    it('replaces the line a pre-release token-graph build wrote', async () => {
      const existing = '0 5 * * * backup\n17 * * * * old # token-graph-sync\n';
      const h = harness('linux', (_c, args) => (args[0] === '-l' ? { code: 0, stdout: existing, stderr: '' } : ok));
      await runSchedule({ remove: false, dryRun: false }, h.deps);
      const stdin = h.calls.find((c) => c.args[0] === '-')?.stdin ?? '';
      expect(stdin).not.toContain('old');
      expect(stdin).not.toContain('token-graph-sync');
      expect(stdin.match(/tokengraph-sync/g)).toHaveLength(1);
    });

    it('does not touch the crontab when crontab -l fails for another reason', async () => {
      const h = harness('linux', () => ({ code: 1, stdout: '', stderr: 'permission denied' }));
      expect(await runSchedule({ remove: false, dryRun: false }, h.deps)).toBe(1);
      expect(h.calls.filter((c) => c.args[0] === '-')).toEqual([]);
      expect(out.join('\n')).toContain('permission denied');
    });

    it('reports a failing crontab write', async () => {
      const h = harness('linux', (_c, args) => (args[0] === '-' ? { code: 1, stdout: '', stderr: 'bad entry' } : { code: 1, stdout: '', stderr: 'no crontab for me' }));
      expect(await runSchedule({ remove: false, dryRun: false }, h.deps)).toBe(1);
    });

    it('remove keeps other lines', async () => {
      const existing = `0 5 * * * backup\n17 * * * * old ${CRON_MARKER}\n`;
      const h = harness('linux', (_c, args) => (args[0] === '-l' ? { code: 0, stdout: existing, stderr: '' } : ok));
      expect(await runSchedule({ remove: true, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.find((c) => c.args[0] === '-')?.stdin).toBe('0 5 * * * backup\n');
      expect(out.join('\n')).toContain('Removed the hourly sync.');
    });

    it('remove with nothing scheduled writes nothing', async () => {
      const h = harness('linux', noCrontab);
      expect(await runSchedule({ remove: true, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.filter((c) => c.args[0] === '-')).toEqual([]);
      expect(out.join('\n')).toContain('Nothing to do');
    });

    it('dry-run reads the crontab but never writes it', async () => {
      const h = harness('linux', noCrontab);
      expect(await runSchedule({ remove: false, dryRun: true }, h.deps)).toBe(0);
      expect(h.calls.map((c) => c.args)).toEqual([['-l']]);
      expect(h.dirs).toEqual([]);
      expect(out.join('\n')).toContain(CRON_MARKER);
    });

    it('other unix platforms use cron too', async () => {
      const h = harness('freebsd', noCrontab);
      await runSchedule({ remove: false, dryRun: false }, h.deps);
      expect(h.calls.some((c) => c.command === 'crontab' && c.args[0] === '-')).toBe(true);
    });
  });

  describe('win32', () => {
    it('creates an hourly task with schtasks', async () => {
      const h = harness('win32');
      expect(await runSchedule({ remove: false, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.command).toBe('schtasks');
      expect(h.calls[0]?.args.slice(0, 7)).toEqual(['/Create', '/F', '/SC', 'HOURLY', '/TN', 'tokengraph-sync', '/TR']);
      expect(h.calls[0]?.args[7]).toContain('sync --since 30 --trigger schedule');
    });

    it('removes the task', async () => {
      const h = harness('win32');
      expect(await runSchedule({ remove: true, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
        ['schtasks', '/Query', '/TN', 'tokengraph-sync'],
        ['schtasks', '/Delete', '/F', '/TN', 'tokengraph-sync'],
      ]);
    });

    it('remove with no task deletes nothing and succeeds', async () => {
      const h = harness('win32', (_command, args) =>
        args[0] === '/Query' ? { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } : ok,
      );
      expect(await runSchedule({ remove: true, dryRun: false }, h.deps)).toBe(0);
      expect(h.calls.map((c) => c.args[0])).toEqual(['/Query']);
      expect(out.join('\n')).toContain('No hourly sync is installed');
    });

    it('dry-run runs nothing', async () => {
      const h = harness('win32');
      expect(await runSchedule({ remove: false, dryRun: true }, h.deps)).toBe(0);
      expect(h.calls).toEqual([]);
      expect(out.join('\n')).toContain('schtasks /Create');
    });
  });
});
