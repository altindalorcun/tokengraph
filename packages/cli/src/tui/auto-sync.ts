import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eventsWithHook, isTokenGraphGeminiHookCommand, isTokenGraphHookCommand, matchingCommands, type Settings } from '../hook-settings.js';
import { isTokenGraphCursorHookCommand, matchingCursorCommands, type CursorHooksFile } from '../cursor-hooks-json.js';
import { SCHEDULE_LABEL, hasCronEntry } from '../schedule-entries.js';
import { codexNotifyOwner, tokenGraphNotifyArgs } from '../codex-config-toml.js';
import { codexHookApproval, codexHookKey, codexHookPositions, codexHooksFileProblem, codexHooksOffReason, type CodexHooksFile } from '../codex-hooks.js';

/** true installed, false not installed, null unknown (unreadable, unsupported platform, timed out). */
export interface AutoSyncStatus {
  claudeHook: boolean | null;
  cursorHook: boolean | null;
  /** tokengraph's Codex sync, by either mechanism: our `notify`, or our `Stop` hook in hooks.json. */
  codexNotify: boolean | null;
  geminiHook: boolean | null;
  schedule: boolean | null;
  /** Which Codex mechanism is in use or would be used; absent or null when unknown. */
  codex?: CodexSetup | null;
}

export interface CodexSetup {
  /** The mechanism tokengraph's sync uses, null when neither is installed. */
  via: 'notify' | 'hook' | null;
  /** For the hook: whether Codex has an approval for it (Codex runs a user hook only once it is approved). */
  approval: 'approved' | 'pending' | 'disabled' | null;
  /** Another program holds Codex's single `notify`, so an install adds the hook instead. */
  notifyTaken: boolean;
  /** Why neither mechanism can be installed (notify taken and hooks turned off), else null. */
  blocked: string | null;
  /** The `"<node>" "<bin>" …` command the installed mechanism runs. */
  commands: string[][];
}

export interface AutoSyncDeps {
  platform: NodeJS.Platform;
  home: () => string;
  env: NodeJS.ProcessEnv;
  readText: (path: string) => Promise<string | null>; // null when missing
  exists: (path: string) => Promise<boolean>;
  crontab: () => Promise<string | null>; // `crontab -l` stdout, null on failure/timeout (2 s)
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `crontab -l` exits non-zero with "no crontab for <user>" when there is none: that is an empty crontab, not unknown. */
export function crontabOutput(error: Error | null, stdout: string, stderr: string): string | null {
  if (!error) return stdout;
  return /no crontab/i.test(stderr) ? '' : null;
}

function crontab(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('crontab', ['-l'], { timeout: 2000 }, (error, stdout, stderr) => resolve(crontabOutput(error, stdout, stderr)));
  });
}

export const DEFAULT_AUTO_SYNC_DEPS: AutoSyncDeps = { platform: process.platform, home: homedir, env: process.env, readText, exists, crontab };

/** Reads tokengraph's Codex sync from config.toml and hooks.json under CODEX_HOME. Throws on an unreadable hooks.json. */
export async function inspectCodexSetup(deps: AutoSyncDeps): Promise<CodexSetup> {
  const home = deps.env['CODEX_HOME'] || join(deps.home(), '.codex');
  const toml = (await deps.readText(join(home, 'config.toml'))) ?? '';
  const owner = codexNotifyOwner(toml);
  const hooksPath = join(home, 'hooks.json');
  const hooksText = await deps.readText(hooksPath);
  let hooks: unknown = {};
  let problem: string | null = null;
  try {
    if (hooksText !== null) hooks = JSON.parse(hooksText);
    problem = codexHooksFileProblem(hooks);
  } catch (error) {
    problem = `not valid JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (problem !== null && owner !== 'ours') throw new Error(`${hooksPath}: ${problem}`);
  const positions = problem === null ? codexHookPositions(hooks as CodexHooksFile) : [];
  const notifyTaken = owner === 'foreign';
  if (owner === 'ours') return { via: 'notify', approval: null, notifyTaken, blocked: null, commands: [tokenGraphNotifyArgs(toml) ?? []] };
  if (positions.length > 0) {
    const approval = codexHookApproval(toml, codexHookKey(hooksPath, positions[0]!));
    return { via: 'hook', approval, notifyTaken, blocked: null, commands: positions.map((p) => commandWords(p.command)) };
  }
  const requirements = deps.platform === 'win32' ? null : await deps.readText('/etc/codex/requirements.toml').catch(() => null);
  const off = notifyTaken ? codexHooksOffReason(toml, requirements) : null;
  return { via: null, approval: null, notifyTaken, blocked: off, commands: [] };
}

/** The node and script paths at the start of `"<node>" "<bin>" …`, then the rest. */
function commandWords(command: string): string[] {
  const match = /^"([^"]+)" "([^"]+)"(.*)$/.exec(command);
  return match ? [match[1]!, match[2]!, ...match[3]!.trim().split(/\s+/).filter(Boolean)] : [];
}

/** Parses JSON from `path`: false when the file is missing, null when it is unreadable or invalid, else `check(json)`. */
async function checkJsonFile(
  deps: AutoSyncDeps,
  path: string,
  check: (json: Record<string, unknown>) => boolean,
): Promise<boolean | null> {
  const text = await deps.readText(path);
  if (text === null) return false;
  const json: unknown = JSON.parse(text);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  return check(json as Record<string, unknown>);
}

async function scheduleInstalled(deps: AutoSyncDeps): Promise<boolean | null> {
  if (deps.platform === 'darwin') return deps.exists(join(deps.home(), 'Library', 'LaunchAgents', `${SCHEDULE_LABEL}.plist`));
  if (deps.platform === 'linux') {
    const table = await deps.crontab();
    return table === null ? null : hasCronEntry(table);
  }
  return null;
}

/** Runs one check; any failure makes that field unknown rather than failing the whole detection. */
async function guarded(check: () => Promise<boolean | null>): Promise<boolean | null> {
  try {
    return await check();
  } catch {
    return null;
  }
}

/** Best-effort look at which auto-sync mechanisms are installed. Never throws. */
export async function detectAutoSync(overrides: Partial<AutoSyncDeps> = {}): Promise<AutoSyncStatus> {
  const deps: AutoSyncDeps = { ...DEFAULT_AUTO_SYNC_DEPS, ...overrides };
  const [claudeHook, cursorHook, codex, geminiHook, schedule] = await Promise.all([
    guarded(() =>
      checkJsonFile(deps, join(deps.env['CLAUDE_CONFIG_DIR'] || join(deps.home(), '.claude'), 'settings.json'), (json) =>
        eventsWithHook(json as Settings, isTokenGraphHookCommand).length > 0),
    ),
    guarded(() =>
      checkJsonFile(deps, join(deps.home(), '.cursor', 'hooks.json'), (json) =>
        matchingCursorCommands(json as CursorHooksFile, isTokenGraphCursorHookCommand).length > 0),
    ),
    inspectCodexSetup(deps).catch(() => null),
    guarded(() =>
      checkJsonFile(deps, join(deps.env['GEMINI_CLI_HOME'] || deps.home(), '.gemini', 'settings.json'), (json) =>
        matchingCommands(json as Settings, 'SessionEnd', isTokenGraphGeminiHookCommand).length > 0),
    ),
    guarded(() => scheduleInstalled(deps)),
  ]);
  const codexNotify = codex === null ? null : codex.via !== null;
  return { claudeHook, cursorHook, codexNotify, geminiHook, schedule, codex };
}
