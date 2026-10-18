import { existsSync } from 'node:fs';
import { readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { readConfig, type CliConfig } from '../config.js';
import { configHome } from '../paths.js';
import { askYesNo } from '../prompt.js';
import { DEFAULT_HOOK_EVENT, runInstallHook, type HookAgent } from './install-hook.js';
import { runSchedule } from './schedule.js';

export interface UninstallOptions {
  purge: boolean;
  yes: boolean;
  dryRun: boolean;
}

export interface UninstallDeps {
  removeHook: (agent: HookAgent, dryRun: boolean) => Promise<number>;
  removeSchedule: (dryRun: boolean) => Promise<number>;
  readConfig: () => Promise<CliConfig>;
  /** The data folder to purge. */
  dataHome: () => string;
  /** The user's home directory, which must never be purged. */
  userHome: () => string;
  isTty: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  /** Recursively deletes a folder. */
  removeDir: (path: string) => Promise<void>;
}

const DEFAULT_DEPS: UninstallDeps = {
  removeHook: (agent, dryRun) => runInstallHook({ agent, event: DEFAULT_HOOK_EVENT, remove: true, dryRun }),
  removeSchedule: (dryRun) => runSchedule({ remove: true, dryRun }),
  readConfig: () => readConfig(),
  dataHome: () => configHome(),
  userHome: () => homedir(),
  isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: (question) => askYesNo(question, { defaultYes: false }),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
};

const HOOK_AGENTS: readonly HookAgent[] = ['claude-code', 'cursor', 'codex'];
/** A folder is only purged when it holds at least one of these: proof that it is tokengraph's own. */
const OWN_FILES = ['config.json', 'state.json', 'cursor-events.jsonl', 'cursor-import.jsonl'];
const CURSOR_FILES = ['cursor-events.jsonl', 'cursor-import.jsonl'];

/** The folder's resolved path when it is safe to delete, else the reason it is not. */
async function purgeTarget(dir: string, userHome: string): Promise<{ path: string } | { refusal: string }> {
  let real: string;
  let realHome: string;
  try {
    real = await realpath(dir);
  } catch {
    return { refusal: `${dir} does not exist.` };
  }
  try {
    realHome = await realpath(userHome);
  } catch {
    realHome = userHome;
  }
  if (real === realHome) return { refusal: `${dir} is your home directory.` };
  if (parse(real).root === real) return { refusal: `${dir} is a filesystem root.` };
  const entries = await readdir(real).catch(() => [] as string[]);
  if (!OWN_FILES.some((name) => entries.includes(name))) {
    return { refusal: `${dir} holds none of ${OWN_FILES.join(', ')}, so it does not look like tokengraph's folder.` };
  }
  return { path: real };
}

export async function runUninstall(options: UninstallOptions, overrides: Partial<UninstallDeps> = {}): Promise<number> {
  const deps: UninstallDeps = { ...DEFAULT_DEPS, ...overrides };

  if (options.purge && !options.dryRun && !options.yes && !deps.isTty()) {
    console.error('--purge deletes your data and needs a confirmation: run it in a terminal, or add --yes.');
    return 1;
  }

  // Read before anything is deleted: the gist ids live in the folder a purge removes.
  const config = options.purge ? await deps.readConfig() : {};

  let failed = 0;
  for (const agent of HOOK_AGENTS) {
    const code = await deps.removeHook(agent, options.dryRun);
    if (code !== 0) {
      failed += 1;
      console.error(`Could not remove the ${agent} hook.`);
    }
  }
  const scheduleCode = await deps.removeSchedule(options.dryRun);
  if (scheduleCode !== 0) {
    failed += 1;
    console.error('Could not remove the hourly schedule.');
  }
  console.log(
    failed === 0
      ? `${options.dryRun ? 'Dry run: would remove' : 'Removed'} the Claude Code, Cursor and Codex hooks and the hourly schedule.`
      : `${failed} of 4 removals failed.`,
  );

  let purgeFailed = false;
  if (options.purge) purgeFailed = !(await purge(options, config, deps));

  console.log('To remove the program too: npm uninstall -g tokengraph');
  return failed > 0 || purgeFailed ? 1 : 0;
}

/** Deletes the data folder after the safety checks. Returns false when it refused or failed. */
async function purge(options: UninstallOptions, config: CliConfig, deps: UninstallDeps): Promise<boolean> {
  const login = config.github?.login;
  const gistUrl = (id: string | undefined) => (id && login ? `https://gist.github.com/${login}/${id}` : id ? `gist ${id}` : null);
  const gists = [
    ['Graph gist', gistUrl(config.gists?.graph)],
    ['Data gist', gistUrl(config.gists?.data)],
  ].filter((entry): entry is [string, string] => entry[1] !== null);
  if (gists.length > 0) {
    console.log('Your gists stay on GitHub until you delete them at https://gist.github.com:');
    for (const [label, url] of gists) console.log(`  ${label}: ${url}`);
  }

  const dir = deps.dataHome();
  const target = await purgeTarget(dir, deps.userHome());
  if ('refusal' in target) {
    if (!existsSync(dir)) {
      console.log(`Nothing to purge: ${target.refusal}`);
      return true;
    }
    console.error(`Refusing to delete: ${target.refusal}`);
    return false;
  }

  const entries = (await readdir(target.path, { withFileTypes: true })).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  console.log(`${options.dryRun ? 'Would delete' : 'This deletes'} ${target.path}, containing:`);
  for (const name of entries.sort()) console.log(`  ${name}`);
  const cursorFiles = CURSOR_FILES.filter((name) => entries.includes(name));
  if (cursorFiles.length > 0) {
    console.log(
      `Warning: ${cursorFiles.join(' and ')} ${cursorFiles.length > 1 ? 'are' : 'is'} the only copy of your Cursor usage. ` +
        'Unless you published it, it cannot be restored.',
    );
  }
  if (options.dryRun) return true;

  if (!options.yes && !(await deps.confirm(`Delete ${target.path} and everything in it?`))) {
    console.log('Kept your data folder.');
    return true;
  }
  try {
    await deps.removeDir(target.path);
  } catch (error) {
    console.error(`Could not delete ${target.path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  console.log(`Deleted ${target.path}.`);
  return true;
}
