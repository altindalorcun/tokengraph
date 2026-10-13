import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { binPath } from '../bin-path.js';
import { configHome, hookSyncLogPath, hookSyncStampPath } from '../paths.js';

/** How far back the hook-triggered sync reads. */
export const HOOK_WINDOW_DAYS = 30;

export interface HookSyncDeps {
  spawn: (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'unref'>;
  /** Opens (truncating) the log and returns a file descriptor. */
  openLog: (path: string) => number;
  closeLog: (fd: number) => void;
  writeLog: (fd: number, text: string) => void;
  binPath: () => string;
  now: () => Date;
  /** Epoch ms of the last start recorded by `writeStamp`, or null when there is none. */
  readStamp: () => number | null;
  writeStamp: (ms: number) => void;
}

export interface HookSyncOptions {
  /** Skip the run when the previous one started less than this many seconds ago. */
  minIntervalSeconds?: number;
}

const DEFAULT_DEPS: HookSyncDeps = {
  spawn: (command, args, options) => spawn(command, args, options),
  openLog: (path) => {
    mkdirSync(configHome(), { recursive: true, mode: 0o700 });
    return openSync(path, 'w', 0o600);
  },
  closeLog: closeSync,
  writeLog: (fd, text) => {
    writeSync(fd, text);
  },
  // Same resolution as install-hook's hookCommand, independent of how this process was started.
  binPath,
  now: () => new Date(),
  readStamp: () => {
    try {
      const ms = Number(readFileSync(hookSyncStampPath(), 'utf8').trim());
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  },
  writeStamp: (ms) => {
    try {
      mkdirSync(configHome(), { recursive: true, mode: 0o700 });
      writeFileSync(hookSyncStampPath(), String(ms), { mode: 0o600 });
    } catch {
      // Best effort: a missing stamp only means the next run is not throttled.
    }
  },
};

/** True when the previous start is recent enough that this run should be skipped. */
function isThrottled(deps: HookSyncDeps, minIntervalSeconds: number | undefined): boolean {
  if (minIntervalSeconds === undefined || !(minIntervalSeconds > 0)) return false;
  try {
    const last = deps.readStamp();
    if (last === null) return false;
    const elapsed = deps.now().getTime() - last;
    // A stamp in the future (clock change) must not block syncing indefinitely.
    return elapsed >= 0 && elapsed < minIntervalSeconds * 1000;
  } catch {
    return false;
  }
}

/**
 * Hidden command run by the Claude Code SessionEnd hook. Claude Code cancels hooks after ~1.5s, so
 * this only launches `sync` as a fully detached process and returns immediately. It never throws
 * and never fails: a broken hook must not disturb the agent session. stdin is deliberately ignored.
 * With `minIntervalSeconds` (the Codex notify hook fires after every turn) a run that comes too soon
 * after the previous start does nothing; without it, every run syncs.
 */
export function runHookSync(partial: Partial<HookSyncDeps> = {}, options: HookSyncOptions = {}): number {
  const deps = { ...DEFAULT_DEPS, ...partial };
  if (isThrottled(deps, options.minIntervalSeconds)) return 0;
  let fd: number | undefined;
  try {
    fd = deps.openLog(hookSyncLogPath());
    deps.writeLog(fd, `[${deps.now().toISOString()}] hook-sync: starting sync --since ${HOOK_WINDOW_DAYS}\n`);
    const child = deps.spawn(
      process.execPath,
      [deps.binPath(), 'sync', '--since', String(HOOK_WINDOW_DAYS), '--trigger', 'hook'],
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      },
    );
    child.unref();
    if (options.minIntervalSeconds !== undefined) deps.writeStamp(deps.now().getTime());
  } catch (error) {
    if (fd !== undefined) {
      try {
        deps.writeLog(fd, `hook-sync: error: ${error instanceof Error ? error.message : String(error)}\n`);
      } catch {
        // Best effort only.
      }
    }
  } finally {
    if (fd !== undefined) {
      try {
        deps.closeLog(fd);
      } catch {
        // Best effort only.
      }
    }
  }
  return 0;
}
