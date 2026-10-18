import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configHome(): string {
  const override = process.env['TOKENGRAPH_HOME'];
  if (override !== undefined) return override;
  // Last line of defence: a test run that skipped the setup file must fail loudly, not touch the real ~/.tokengraph.
  if (process.env['VITEST'] !== undefined) {
    throw new Error(
      'TOKENGRAPH_HOME is not set under vitest: tests must run with test/setup-home.ts (start vitest from the repo root or a package).',
    );
  }
  return join(homedir(), '.tokengraph');
}

/** Where pre-release builds (named `token-graph`) kept their state. */
export function legacyConfigHome(): string {
  return join(homedir(), '.token-graph');
}

export interface MigrateHomeDeps {
  exists: (path: string) => boolean;
  rename: (from: string, to: string) => void;
}

const DEFAULT_MIGRATE_DEPS: MigrateHomeDeps = { exists: existsSync, rename: renameSync };

/**
 * Moves the pre-release `~/.token-graph` folder to `~/.tokengraph` once. The ledger and Cursor's event file
 * there are the only record of usage whose transcripts are gone, so they must never be left behind or replaced:
 * this only renames, only when the new folder does not exist yet, and never fails the command that called it.
 * Skipped when `TOKENGRAPH_HOME` points elsewhere.
 */
export function migrateLegacyHome(
  deps: MigrateHomeDeps = DEFAULT_MIGRATE_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): 'moved' | 'none' | 'failed' {
  if (env['TOKENGRAPH_HOME'] !== undefined) return 'none';
  const from = legacyConfigHome();
  const to = join(homedir(), '.tokengraph');
  try {
    if (!deps.exists(from) || deps.exists(to)) return 'none';
    deps.rename(from, to);
    return 'moved';
  } catch {
    // Another process moved it first, or the home directory is read-only: the old folder stays where it was.
    return 'failed';
  }
}

export function ledgerPath(): string {
  return join(configHome(), 'state.json');
}

export function configPath(): string {
  return join(configHome(), 'config.json');
}

export function hookSyncLogPath(): string {
  return join(configHome(), 'hook-sync.log');
}

/** Epoch ms of the last hook-triggered sync start, used to throttle `hook-sync --min-interval`. */
export function hookSyncStampPath(): string {
  return join(configHome(), 'hook-sync.last');
}

export function syncLockPath(): string {
  return join(configHome(), 'sync.lock');
}

/** Other machines' files from the data gist, as of the last publish (`publish/machines-cache.ts`). */
export function machinesCachePath(): string {
  return join(configHome(), 'machines.json');
}
