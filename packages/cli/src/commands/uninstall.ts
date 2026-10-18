import { readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative } from 'node:path';
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
  cwd: () => string;
  removeFile: (path: string) => Promise<void>;
  /** Removes a folder only if it is empty. */
  removeEmptyDir: (path: string) => Promise<void>;
}

const DEFAULT_DEPS: UninstallDeps = {
  removeHook: (agent, dryRun) => runInstallHook({ agent, event: DEFAULT_HOOK_EVENT, remove: true, dryRun }),
  removeSchedule: (dryRun) => runSchedule({ remove: true, dryRun }),
  readConfig: () => readConfig(),
  dataHome: () => configHome(),
  userHome: () => homedir(),
  isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: (question) => askYesNo(question, { defaultYes: false }),
  cwd: () => process.cwd(),
  removeFile: (path) => rm(path, { force: true }),
  removeEmptyDir: (path) => rmdir(path),
};

const HOOK_AGENTS: readonly HookAgent[] = ['claude-code', 'cursor', 'codex'];
/** A folder is only purged when it holds at least one of these: proof that it is tokengraph's own. */
/**
 * Every file the CLI writes into its data folder (paths.ts, adapters/cursor/events.ts, commands/schedule.ts),
 * deleted by exact name. Nothing else in the folder is ever touched, and nothing is deleted recursively.
 */
const OWN_FILES = [
  'config.json',
  'state.json',
  'machines.json',
  'cursor-events.jsonl',
  'cursor-import.jsonl',
  'hook-sync.log',
  'hook-sync.last',
  'sync.lock',
  'schedule.log',
];
/** Temp files the atomic writers (ledger.ts, config.ts, publish/machines-cache.ts) leave if interrupted. */
const OWN_TEMP = /^(?:state|config|machines)\.json\.[\d.]+\.tmp$/;
const CURSOR_FILES = ['cursor-events.jsonl', 'cursor-import.jsonl'];

const isOwn = (name: string): boolean => OWN_FILES.includes(name) || OWN_TEMP.test(name);

interface PurgePlan {
  path: string;
  files: string[];
  kept: string[];
}

/** What a purge would delete and keep, or why it must not run. `missing` means there is no folder at all. */
async function planPurge(dir: string, deps: UninstallDeps): Promise<PurgePlan | { missing: true } | { refusal: string }> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { refusal: `${dir} cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const resolve = (path: string) => realpath(path).catch(() => path);
  const realHome = await resolve(deps.userHome());
  const realCwd = await resolve(deps.cwd());
  if (real === realHome) return { refusal: `${dir} is your home directory.` };
  if (parse(real).root === real) return { refusal: `${dir} is a filesystem root.` };
  for (const [label, target] of [['your home directory', realHome], ['the current directory', realCwd]] as const) {
    const rel = relative(real, target);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return { refusal: `${dir} contains ${label}.` };
    }
  }
  let entries: string[];
  try {
    entries = await readdir(real);
  } catch (error) {
    return { refusal: `${dir} cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  entries.sort();
  return { path: real, files: entries.filter(isOwn), kept: entries.filter((name) => !isOwn(name)) };
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

  const plan = await planPurge(deps.dataHome(), deps);
  if ('missing' in plan) {
    console.log(`Nothing to purge: ${deps.dataHome()} does not exist.`);
    return true;
  }
  if ('refusal' in plan) {
    console.error(`Refusing to delete: ${plan.refusal}`);
    return false;
  }

  console.log(`${options.dryRun ? 'Would delete' : 'This deletes'} these files in ${plan.path}:`);
  for (const name of plan.files) console.log(`  ${name}`);
  if (plan.files.length === 0) console.log('  (none)');
  if (plan.kept.length > 0) {
    console.log(`Not tokengraph's, so kept (and the folder with them): ${plan.kept.join(', ')}`);
  }
  const cursorFiles = CURSOR_FILES.filter((name) => plan.files.includes(name));
  if (cursorFiles.length > 0) {
    console.log(
      `Warning: ${cursorFiles.join(' and ')} ${cursorFiles.length > 1 ? 'are' : 'is'} the only copy of your Cursor usage. ` +
        'Unless you published it, it cannot be restored.',
    );
  }
  if (options.dryRun) return true;

  if (plan.files.length > 0 && !options.yes && !(await deps.confirm(`Delete these files from ${plan.path}?`))) {
    console.log('Kept your data folder.');
    return true;
  }
  try {
    for (const name of plan.files) await deps.removeFile(join(plan.path, name));
    if (plan.kept.length === 0) await deps.removeEmptyDir(plan.path);
  } catch (error) {
    console.error(`Could not delete from ${plan.path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  console.log(plan.kept.length === 0 ? `Deleted ${plan.path}.` : `Deleted tokengraph's files from ${plan.path}.`);
  return true;
}
