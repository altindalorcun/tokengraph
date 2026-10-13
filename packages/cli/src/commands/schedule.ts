import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { binPath, ephemeralInstallError } from '../bin-path.js';
import { stableNodePath } from '../node-path.js';
import { configHome } from '../paths.js';
import {
  cronLine,
  hasCronEntry,
  launchdPlist,
  SCHEDULE_LABEL,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  scheduledArgs,
  withCronEntry,
  withoutCronEntry,
} from '../schedule-entries.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ScheduleDeps {
  platform: NodeJS.Platform;
  run: (command: string, args: string[], stdin?: string) => Promise<RunResult>;
  writeFile: (path: string, text: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  /** Creates a directory (and parents). Needed so the scheduler can open the log file. */
  ensureDir: (path: string) => Promise<void>;
  uid: () => number;
  home: () => string;
  /** Waits; injected so tests do not. */
  sleep: (ms: number) => Promise<void>;
  /** The minute of the hour cron runs the sync at, 0-59. */
  cronMinute: () => number;
}

export interface ScheduleOptions {
  remove: boolean;
  dryRun: boolean;
}

/** Runs a program without a shell, collecting its output. A program that cannot start resolves with code 127. */
function spawnRun(command: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: stderr || error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

const defaultDeps: ScheduleDeps = {
  platform: process.platform,
  run: spawnRun,
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  },
  removeFile: (path) => rm(path, { force: true }),
  ensureDir: async (path) => void (await mkdir(path, { recursive: true })),
  uid: () => process.getuid?.() ?? 0,
  home: () => homedir(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  cronMinute: () => randomInt(60),
};

const BOOTSTRAP_RETRY_MS = 500;
/** Printed after every install, so turning the schedule off is never a guess. */
const TURN_OFF_HINT = 'Turn it off any time with: tokengraph schedule --remove';

function failure(what: string, result: RunResult): number {
  console.error(`${what} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || 'no output'}`);
  return 1;
}

/**
 * Paths are built with the target platform's rules, not the host's: the scheduler reads them on that
 * platform, and the tests drive every platform from whichever host runs them.
 */
function logPath(deps: ScheduleDeps): string {
  return (deps.platform === 'win32' ? win32 : posix).join(configHome(), 'schedule.log');
}

function launchdPlistPath(deps: ScheduleDeps): string {
  return posix.join(deps.home(), 'Library', 'LaunchAgents', `${SCHEDULE_LABEL}.plist`);
}

async function scheduleDarwin(options: ScheduleOptions, deps: ScheduleDeps, args: string[]): Promise<number> {
  const plistPath = launchdPlistPath(deps);
  const target = `gui/${deps.uid()}`;
  const bootout = () => deps.run('launchctl', ['bootout', `${target}/${SCHEDULE_LABEL}`]);

  if (options.remove) {
    if (options.dryRun) {
      console.log(`Would run: launchctl bootout ${target}/${SCHEDULE_LABEL}`);
      console.log(`Would delete ${plistPath}`);
      return 0;
    }
    await bootout(); // not loaded is fine
    await deps.removeFile(plistPath);
    console.log('Removed the hourly sync.');
    return 0;
  }

  const plist = launchdPlist(args, logPath(deps));
  if (options.dryRun) {
    console.log(`Would write ${plistPath}:\n`);
    console.log(plist);
    console.log(`Then run: launchctl bootout ${target}/${SCHEDULE_LABEL} (ignoring failure)`);
    console.log(`          launchctl bootstrap ${target} ${plistPath}`);
    return 0;
  }
  await deps.ensureDir(configHome());
  await deps.writeFile(plistPath, plist);
  await bootout(); // replace any older job; not loaded is fine
  const bootstrapCommand = () => deps.run('launchctl', ['bootstrap', target, plistPath]);
  let bootstrap = await bootstrapCommand();
  if (bootstrap.code !== 0) {
    // launchd can still be tearing the old job down right after bootout; one retry covers it.
    await deps.sleep(BOOTSTRAP_RETRY_MS);
    bootstrap = await bootstrapCommand();
  }
  if (bootstrap.code !== 0) return failure('launchctl bootstrap', bootstrap);
  console.log('Scheduled an hourly sync.');
  console.log(TURN_OFF_HINT);
  console.log(`launchd: ${plistPath}`);
  console.log(`Log: ${logPath(deps)}`);
  return 0;
}

/** `crontab -l` exits non-zero with "no crontab for <user>" when there is none: that is an empty crontab. */
async function readCrontab(deps: ScheduleDeps): Promise<{ text: string } | { error: RunResult }> {
  const result = await deps.run('crontab', ['-l']);
  if (result.code === 0) return { text: result.stdout };
  if (/no crontab/i.test(result.stderr)) return { text: '' };
  return { error: result };
}

async function scheduleCron(options: ScheduleOptions, deps: ScheduleDeps, args: string[]): Promise<number> {
  const current = await readCrontab(deps);
  if ('error' in current) return failure('crontab -l', current.error);

  if (options.remove) {
    const next = withoutCronEntry(current.text);
    if (!hasCronEntry(current.text)) {
      console.log('No tokengraph entry in your crontab. Nothing to do.');
      return 0;
    }
    if (options.dryRun) {
      console.log('Would write this crontab:\n');
      console.log(next);
      return 0;
    }
    const written = await deps.run('crontab', ['-'], next);
    if (written.code !== 0) return failure('crontab', written);
    console.log('Removed the hourly sync.');
    return 0;
  }

  const next = withCronEntry(current.text, cronLine(args, logPath(deps), deps.cronMinute()));
  if (options.dryRun) {
    console.log('Would write this crontab:\n');
    console.log(next);
    return 0;
  }
  await deps.ensureDir(configHome());
  const written = await deps.run('crontab', ['-'], next);
  if (written.code !== 0) return failure('crontab', written);
  console.log('Scheduled an hourly sync.');
  console.log(TURN_OFF_HINT);
  console.log('cron: your user crontab (the line ends with the tokengraph-sync comment)');
  console.log(`Log: ${logPath(deps)}`);
  return 0;
}

async function scheduleWindows(options: ScheduleOptions, deps: ScheduleDeps, args: string[]): Promise<number> {
  const schtasksArgs = options.remove ? schtasksDeleteArgs() : schtasksCreateArgs(args);
  if (options.dryRun) {
    console.log(`Would run: schtasks ${schtasksArgs.join(' ')}`);
    return 0;
  }
  const result = await deps.run('schtasks', schtasksArgs);
  if (result.code !== 0) return failure('schtasks', result);
  if (options.remove) {
    console.log('Removed the hourly sync.');
  } else {
    console.log('Scheduled an hourly sync.');
  console.log(TURN_OFF_HINT);
    console.log('Task Scheduler: task "tokengraph-sync"');
  }
  return 0;
}

export async function runSchedule(options: ScheduleOptions, overrides: Partial<ScheduleDeps> = {}): Promise<number> {
  const deps: ScheduleDeps = { ...defaultDeps, ...overrides };
  const bin = binPath();
  const ephemeral = options.remove ? null : ephemeralInstallError('tokengraph schedule', bin);
  if (ephemeral) {
    console.error(ephemeral);
    return 1;
  }
  const args = scheduledArgs(stableNodePath(process.execPath), bin);
  if (deps.platform === 'darwin') return scheduleDarwin(options, deps, args);
  if (deps.platform === 'win32') return scheduleWindows(options, deps, args);
  return scheduleCron(options, deps, args);
}
