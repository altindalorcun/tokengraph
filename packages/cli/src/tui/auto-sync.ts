import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eventsWithHook, isTokenGraphGeminiHookCommand, isTokenGraphHookCommand, matchingCommands, type Settings } from '../hook-settings.js';
import { isTokenGraphCursorHookCommand, matchingCursorCommands, type CursorHooksFile } from '../cursor-hooks-json.js';
import { SCHEDULE_LABEL, hasCronEntry } from '../schedule-entries.js';

/** true installed, false not installed, null unknown (unreadable, unsupported platform, timed out). */
export interface AutoSyncStatus {
  claudeHook: boolean | null;
  cursorHook: boolean | null;
  codexNotify: boolean | null;
  geminiHook: boolean | null;
  schedule: boolean | null;
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

/** True when a top-level `notify` line in config.toml runs tokengraph's hook-sync. */
export function hasTokenGraphNotify(toml: string): boolean {
  const lines = toml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\[/.test(line)) return false; // first table header: everything after is not top-level
    if (!/^\s*notify\s*=/.test(line)) continue;
    // The array may continue on the following lines until its closing `]`.
    let text = line;
    while (!text.includes(']') && i + 1 < lines.length) text += `\n${lines[++i]!}`;
    return text.includes('hook-sync') && /token-?graph/.test(text);
  }
  return false;
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
  const [claudeHook, cursorHook, codexNotify, geminiHook, schedule] = await Promise.all([
    guarded(() =>
      checkJsonFile(deps, join(deps.env['CLAUDE_CONFIG_DIR'] || join(deps.home(), '.claude'), 'settings.json'), (json) =>
        eventsWithHook(json as Settings, isTokenGraphHookCommand).length > 0),
    ),
    guarded(() =>
      checkJsonFile(deps, join(deps.home(), '.cursor', 'hooks.json'), (json) =>
        matchingCursorCommands(json as CursorHooksFile, isTokenGraphCursorHookCommand).length > 0),
    ),
    guarded(async () => {
      const toml = await deps.readText(join(deps.env['CODEX_HOME'] ?? join(deps.home(), '.codex'), 'config.toml'));
      return toml === null ? false : hasTokenGraphNotify(toml);
    }),
    guarded(() =>
      checkJsonFile(deps, join(deps.env['GEMINI_CLI_HOME'] || deps.home(), '.gemini', 'settings.json'), (json) =>
        matchingCommands(json as Settings, 'SessionEnd', isTokenGraphGeminiHookCommand).length > 0),
    ),
    guarded(() => scheduleInstalled(deps)),
  ]);
  return { claudeHook, cursorHook, codexNotify, geminiHook, schedule };
}
