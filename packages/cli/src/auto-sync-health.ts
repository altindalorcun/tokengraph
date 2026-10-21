import { join } from 'node:path';
import { eventsWithHook, isTokenGraphGeminiHookCommand, isTokenGraphHookCommand, matchingCommands, type Settings } from './hook-settings.js';
import { isTokenGraphCursorHookCommand, matchingCursorCommands, type CursorHooksFile } from './cursor-hooks-json.js';
import { hasCronEntry, SCHEDULE_LABEL } from './schedule-entries.js';
import { DEFAULT_AUTO_SYNC_DEPS, type AutoSyncDeps } from './tui/auto-sync.js';

/**
 * One background-sync mechanism as installed on this machine. Hooks and the schedule store absolute node and
 * script paths, which break when Node is upgraded under a version manager or the package moves; `missing`
 * lists the ones that no longer exist, so `status` can say "reinstall" instead of syncs silently stopping.
 */
export interface AutoSyncEntry {
  /** true installed, false not installed, null unknown (unreadable file, unsupported platform). */
  installed: boolean | null;
  /** Where it is installed, e.g. the Claude Code events carrying the hook. */
  detail?: string;
  /** Paths the installed command runs that are gone. Empty when healthy or not installed. */
  missing: string[];
}

export interface AutoSyncHealth {
  claudeHook: AutoSyncEntry;
  cursorHook: AutoSyncEntry;
  codexNotify: AutoSyncEntry;
  geminiHook: AutoSyncEntry;
  schedule: AutoSyncEntry;
}

const UNKNOWN: AutoSyncEntry = { installed: null, missing: [] };
const ABSENT: AutoSyncEntry = { installed: false, missing: [] };

/** The node and script paths at the start of `"<node>" "<bin>" …`, the shape every hook command we write takes. */
export function commandPaths(command: string): string[] {
  const match = /^"([^"]+)" "([^"]+)"/.exec(command);
  return match ? [match[1]!, match[2]!] : [];
}

async function missingPaths(deps: AutoSyncDeps, paths: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const path of new Set(paths)) if (!(await deps.exists(path))) missing.push(path);
  return missing;
}

async function readJson(deps: AutoSyncDeps, path: string): Promise<Record<string, unknown> | null | undefined> {
  const text = await deps.readText(path);
  if (text === null) return undefined;
  const json: unknown = JSON.parse(text);
  return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
}

async function claudeHook(deps: AutoSyncDeps): Promise<AutoSyncEntry> {
  const settings = await readJson(deps, join(deps.env['CLAUDE_CONFIG_DIR'] || join(deps.home(), '.claude'), 'settings.json'));
  if (settings === undefined) return ABSENT;
  if (settings === null) return UNKNOWN;
  const events = eventsWithHook(settings as Settings, isTokenGraphHookCommand);
  if (events.length === 0) return ABSENT;
  const commands = events.flatMap((event) => matchingCommands(settings as Settings, event, isTokenGraphHookCommand));
  return { installed: true, detail: events.join(', '), missing: await missingPaths(deps, commands.flatMap(commandPaths)) };
}

async function cursorHook(deps: AutoSyncDeps): Promise<AutoSyncEntry> {
  const file = await readJson(deps, join(deps.home(), '.cursor', 'hooks.json'));
  if (file === undefined) return ABSENT;
  if (file === null) return UNKNOWN;
  const commands = matchingCursorCommands(file as CursorHooksFile, isTokenGraphCursorHookCommand);
  if (commands.length === 0) return ABSENT;
  return { installed: true, missing: await missingPaths(deps, commands.flatMap(commandPaths)) };
}

async function geminiHook(deps: AutoSyncDeps): Promise<AutoSyncEntry> {
  const home = deps.env['GEMINI_CLI_HOME'] || deps.home();
  const settings = await readJson(deps, join(home, '.gemini', 'settings.json'));
  if (settings === undefined) return ABSENT;
  if (settings === null) return UNKNOWN;
  const commands = matchingCommands(settings as Settings, 'SessionEnd', isTokenGraphGeminiHookCommand);
  if (commands.length === 0) return ABSENT;
  return { installed: true, detail: 'SessionEnd', missing: await missingPaths(deps, commands.flatMap((c) => commandPaths(c.replace(/^& /, '')))) };
}

/** The string elements of the top-level `notify = [...]` when it runs our hook-sync, else null. */
export function tokenGraphNotifyArgs(toml: string): string[] | null {
  const lines = toml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\[/.test(line)) return null; // first table header: everything after is not top-level
    if (!/^\s*notify\s*=/.test(line)) continue;
    let text = line;
    while (!text.includes(']') && i + 1 < lines.length) text += `\n${lines[++i]!}`;
    const args = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.replace(/\\(.)/g, '$1'));
    const [node, bin, ...rest] = args;
    if (node === undefined || bin === undefined) return null;
    return isTokenGraphHookCommand(`"${node}" "${bin}" ${rest.join(' ')}`) ? args : null;
  }
  return null;
}

async function codexNotify(deps: AutoSyncDeps): Promise<AutoSyncEntry> {
  const toml = await deps.readText(join(deps.env['CODEX_HOME'] ?? join(deps.home(), '.codex'), 'config.toml'));
  const args = toml === null ? null : tokenGraphNotifyArgs(toml);
  if (args === null) return ABSENT;
  return { installed: true, missing: await missingPaths(deps, args.slice(0, 2)) };
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** The first two `ProgramArguments` strings of our launchd plist (node and script). */
export function plistProgramPaths(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].slice(0, 2).map((match) => unescapeXml(match[1]!));
}

/** Our crontab line: the current marker or the pre-release one (see schedule-entries). */
const CRON_LINE = /# token-?graph-sync\s*$/;

/** The node and script paths of our crontab line (`m h dom mon dow "<node>" "<bin>" …`). */
export function cronProgramPaths(crontab: string): string[] {
  const line = crontab.split('\n').find((candidate) => CRON_LINE.test(candidate));
  if (!line) return [];
  const command = line.trim().split(/\s+/).slice(5).join(' ').replaceAll('\\%', '%');
  return commandPaths(command);
}

async function schedule(deps: AutoSyncDeps): Promise<AutoSyncEntry> {
  if (deps.platform === 'darwin') {
    const plist = await deps.readText(join(deps.home(), 'Library', 'LaunchAgents', `${SCHEDULE_LABEL}.plist`));
    if (plist === null) return ABSENT;
    return { installed: true, missing: await missingPaths(deps, plistProgramPaths(plist)) };
  }
  if (deps.platform === 'linux') {
    const table = await deps.crontab();
    if (table === null) return UNKNOWN;
    const paths = cronProgramPaths(table);
    if (!hasCronEntry(table)) return ABSENT;
    return { installed: true, missing: await missingPaths(deps, paths) };
  }
  return UNKNOWN;
}

async function guarded(check: () => Promise<AutoSyncEntry>): Promise<AutoSyncEntry> {
  try {
    return await check();
  } catch {
    return UNKNOWN;
  }
}

/** Which background syncs are installed and whether the programs they run still exist. Never throws. */
export async function inspectAutoSync(overrides: Partial<AutoSyncDeps> = {}): Promise<AutoSyncHealth> {
  const deps: AutoSyncDeps = { ...DEFAULT_AUTO_SYNC_DEPS, ...overrides };
  const [claude, cursor, codex, gemini, scheduled] = await Promise.all([
    guarded(() => claudeHook(deps)),
    guarded(() => cursorHook(deps)),
    guarded(() => codexNotify(deps)),
    guarded(() => geminiHook(deps)),
    guarded(() => schedule(deps)),
  ]);
  return { claudeHook: claude, cursorHook: cursor, codexNotify: codex, geminiHook: gemini, schedule: scheduled };
}
