import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { binPath, ephemeralInstallError } from '../bin-path.js';
import { codexConfigPath, codexNotifyArgs, removeCodexNotify, setCodexNotify } from '../codex-config-toml.js';
import {
  addCursorHook,
  hasCursorHook,
  isTokenGraphCursorHookCommand,
  matchingCursorCommands,
  removeCursorHook,
} from '../cursor-hooks-json.js';
import { renameWithRetry } from '../fs-retry.js';
import {
  addHook,
  eventsWithHook,
  hasHook,
  isTokenGraphHookCommand,
  matchingCommands,
  removeHook,
  type Settings,
} from '../hook-settings.js';
import { stableNodePath } from '../node-path.js';
import { configHome } from '../paths.js';

export const DEFAULT_HOOK_EVENT = 'SessionEnd';

export type HookAgent = 'claude-code' | 'cursor' | 'codex';

const HOOK_AGENTS: readonly HookAgent[] = ['claude-code', 'cursor', 'codex'];

/**
 * `--agent` is required: every agent is named the same way, so nobody installs the Claude Code
 * hook by leaving the flag off while meaning another tool.
 */
export function resolveHookAgent(value: string | undefined): { agent: HookAgent } | { error: string } {
  if (value === undefined) {
    return {
      error:
        '--agent is required. Use one of:\n' +
        HOOK_AGENTS.map((agent) => `  tokengraph install-hook --agent ${agent}`).join('\n'),
    };
  }
  const agent = HOOK_AGENTS.find((candidate) => candidate === value);
  return agent ? { agent } : { error: '--agent must be claude-code, cursor or codex.' };
}

export interface InstallHookOptions {
  agent: HookAgent;
  event: string;
  remove: boolean;
  dryRun: boolean;
}

function settingsPath(): string {
  return join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'settings.json');
}

export function hookCommand(): string {
  const bin = binPath();
  // hook-sync spawns a detached sync and returns at once, never failing, so no shell redirects are needed
  // (Claude Code cancels SessionEnd hooks after ~1.5s; a full sync takes longer).
  return `"${stableNodePath(process.execPath)}" "${bin}" hook-sync`;
}

export function cursorHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json');
}

export function cursorHookCommand(): string {
  const bin = binPath();
  // cursor-hook never fails and always prints the JSON Cursor expects, so no `|| true` is needed.
  return `"${stableNodePath(process.execPath)}" "${bin}" cursor-hook`;
}

async function readSettings(path: string): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} does not contain a JSON object`);
    }
    return parsed as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Keep a copy of the user's file before touching it.
  await copyFile(path, `${path}.tokengraph.bak`).catch(() => undefined);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  // Retry on Windows' transient sharing violations (see fs-retry.ts).
  await renameWithRetry(temporary, path);
}

async function installCursorHook(options: InstallHookOptions): Promise<number> {
  const path = cursorHooksPath();
  const command = cursorHookCommand();
  const file = await readSettings(path);
  const replacedOlder = matchingCursorCommands(file, isTokenGraphCursorHookCommand).some((existing) => existing !== command);
  const next = options.remove
    ? removeCursorHook(file, isTokenGraphCursorHookCommand)
    : addCursorHook(file, command, isTokenGraphCursorHookCommand);

  if (next === file) {
    console.log(options.remove ? 'No tokengraph Cursor hook found. Nothing to do.' : 'The tokengraph Cursor hook is already installed.');
    return 0;
  }
  if (options.dryRun) {
    console.log(`Would write ${path}:\n`);
    console.log(JSON.stringify(next, null, 2));
    return 0;
  }
  await writeJsonFile(path, next);
  if (options.remove) console.log('Removed the tokengraph Cursor hook.');
  else if (replacedOlder) console.log('Updated the tokengraph hook on stop (replaced an older command).');
  else console.log('Installed the tokengraph Cursor hook on stop.');
  console.log(`hooks: ${path}`);
  if (!options.remove) {
    console.log('\nRestart Cursor so it picks the hook up. From now on each agent turn is recorded locally;');
    console.log('run `tokengraph sync` (for example once at the end of the day) to upload it.');
    console.log('Cursor keeps no usable token counts on disk, so usage from before now cannot be recovered.');
  }
  return hasCursorHook(next, command) === !options.remove ? 0 : 1;
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await copyFile(path, `${path}.tokengraph.bak`).catch(() => undefined);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await renameWithRetry(temporary, path);
}

async function installCodexHook(options: InstallHookOptions): Promise<number> {
  const path = codexConfigPath();
  const text = await readTextOrEmpty(path);
  const edit = options.remove ? removeCodexNotify(text) : setCodexNotify(text, codexNotifyArgs());

  if (edit.kind === 'foreign') {
    console.log('Codex already runs another notify program:');
    console.log(`  ${edit.existing}`);
    console.log('Codex allows only one, so it was left alone. Run `tokengraph schedule` instead to sync every hour.');
    return 1;
  }
  if (edit.kind === 'unchanged') {
    console.log(options.remove ? 'No tokengraph Codex hook found. Nothing to do.' : 'The tokengraph Codex hook is already installed.');
    return 0;
  }
  if (options.dryRun) {
    console.log(`Would write ${path}:\n`);
    console.log(edit.text);
    return 0;
  }
  await writeTextFile(path, edit.text);
  if (options.remove) console.log('Removed the tokengraph Codex hook.');
  else if (edit.replacedOlder) console.log('Updated the tokengraph Codex hook (replaced an older command).');
  else console.log('Installed the tokengraph Codex hook (notify).');
  console.log(`config: ${path}`);
  if (!options.remove) console.log('\nCodex runs it after each turn; it syncs at most every 10 minutes.');
  return 0;
}

export async function runInstallHook(options: InstallHookOptions): Promise<number> {
  const ephemeral = options.remove ? null : ephemeralInstallError(`tokengraph install-hook --agent ${options.agent}`);
  if (ephemeral) {
    console.error(ephemeral);
    return 1;
  }
  if (options.agent === 'cursor') return installCursorHook(options);
  if (options.agent === 'codex') return installCodexHook(options);

  const path = settingsPath();
  const command = hookCommand();
  const settings = await readSettings(path);

  const replacedOlder = matchingCommands(settings, options.event, isTokenGraphHookCommand).some((existing) => existing !== command);
  const next = options.remove
    ? removeHook(settings, options.event, isTokenGraphHookCommand)
    : addHook(settings, options.event, command, isTokenGraphHookCommand);

  const elsewhere = eventsWithHook(settings, isTokenGraphHookCommand, options.event);
  if (elsewhere.length > 0) {
    console.log(
      `Note: tokengraph hooks also exist on ${elsewhere.join(', ')} (not touched). ` +
        `Remove them with \`tokengraph install-hook --agent claude-code --event <event> --remove\` if they are not wanted.`,
    );
  }

  if (next === settings) {
    console.log(
      options.remove
        ? `No tokengraph hook found on ${options.event}. Nothing to do.`
        : `The tokengraph hook is already installed on ${options.event}.`,
    );
    return 0;
  }

  if (options.dryRun) {
    console.log(`Would write ${path}:\n`);
    console.log(JSON.stringify(next, null, 2));
    return 0;
  }

  await writeJsonFile(path, next);

  if (options.remove) console.log(`Removed the tokengraph hook from ${options.event}.`);
  else if (replacedOlder) console.log(`Updated the tokengraph hook on ${options.event} (replaced an older command).`);
  else console.log(`Installed the tokengraph hook on ${options.event}.`);
  console.log(`settings: ${path}`);
  if (!options.remove) {
    const log = join(configHome(), 'hook-sync.log');
    console.log(`\nThe hook starts a background sync; its output goes to ${log}.`);
    console.log(`Run /hooks inside Claude Code to confirm it is registered.`);
    console.log(`If ${options.event} is not a supported event there, run: tokengraph install-hook --agent claude-code --event Stop`);
  }
  return hasHook(next, options.event, command) === !options.remove ? 0 : 1;
}
