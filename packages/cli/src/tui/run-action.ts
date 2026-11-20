import { runLimits } from '../commands/limits.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { format } from 'node:util';
import { cliVersion } from '../bin-path.js';
import { runCursor, runCursorFetchNow } from '../commands/cursor.js';
import { runExport } from '../commands/export.js';
import { runImportCursor } from '../commands/import.js';
import { DEFAULT_HOOK_EVENT, runInstallHook, type HookAgent } from '../commands/install-hook.js';
import { runLogin } from '../commands/login.js';
import { runLogout } from '../commands/logout.js';
import { runReadme } from '../commands/readme.js';
import { runSchedule } from '../commands/schedule.js';
import { runStatus } from '../commands/status.js';
import { runSync } from '../commands/sync.js';
import { runUninstall } from '../commands/uninstall.js';
import { runUpdate } from '../commands/update.js';
import { DeviceFlowError, pollForToken } from '../github/device-flow.js';
import { installGlobally } from '../npm-global.js';
import { configPath, ledgerPath } from '../paths.js';
import { askText, askYesNo } from '../prompt.js';
import { codexAwaitsTrust, type ActionId, type SetupStatus } from './actions.js';
import type { TaskContext, TaskOutcome, TaskRun } from './task-session.js';

export interface ActionResult {
  code: number;
  lines: string[];
}

/** Runs `fn` with the console captured line by line; the console is always put back, and a throw becomes code 1. */
export async function captureOutput(fn: () => Promise<number>): Promise<ActionResult> {
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]): void => {
    lines.push(...format(...args).split('\n'));
  };
  console.log = console.info = console.warn = console.error = capture;
  try {
    return { code: await fn(), lines };
  } catch (error) {
    lines.push(error instanceof Error ? error.message : String(error));
    return { code: 1, lines };
  } finally {
    Object.assign(console, original);
  }
}

function dateStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The export goes to the folder tokengraph was started from; its own line names the full path. */
function exportFile(kind: 'csv' | 'json'): Promise<number> {
  return runExport({ format: kind, out: resolve(process.cwd(), `tokengraph-${dateStamp()}.${kind}`) });
}

/**
 * A path as people paste or drop it into a terminal: surrounding quotes removed, `\ ` escapes undone (macOS
 * Terminal escapes spaces when a file is dropped on it) and a leading `~` taken as the home folder.
 */
export function cleanPathInput(input: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  let path = input.trim();
  const quoted = /^(['"])(.*)\1$/.exec(path);
  if (quoted) path = quoted[2]!;
  // On Windows a backslash separates folders; elsewhere it only escapes the next character.
  else if (platform !== 'win32') path = path.replace(/\\(.)/g, '$1');
  if (path === '~') return home;
  if (path.startsWith('~/')) return (platform === 'win32' ? win32 : posix).resolve(home, path.slice(2));
  return path;
}

async function importCursor(): Promise<number> {
  const answer = await askText('Path to the Cursor usage CSV (empty to cancel):');
  if (answer === '') {
    console.log('Cancelled. Nothing was imported.');
    return 0;
  }
  return runImportCursor(cleanPathInput(answer));
}

function hook(agent: HookAgent, installed: boolean): () => Promise<number> {
  return () => runInstallHook({ agent, event: DEFAULT_HOOK_EVENT, remove: installed, dryRun: false });
}

/** The command behind an action, called the way bin.ts calls it for a plain invocation. An unknown toggle state installs. */
function command(id: ActionId, status: SetupStatus | null): () => Promise<number> {
  const auto = status?.autoSync;
  switch (id) {
    case 'sync': return () => runSync({ sinceDays: 90, local: false, theme: 'light', trigger: 'manual' });
    case 'login': return () => runLogin({ method: 'auto', openBrowser: true });
    case 'logout': return () => runLogout();
    case 'readme': return () => runReadme({ compact: false, colors: undefined });
    case 'colors': return () => runReadme({ compact: false, colors: status?.graphColors === 'single' ? 'model' : 'single' });
    case 'hook:claude-code': return hook('claude-code', auto?.claudeHook === true);
    case 'hook:cursor': return hook('cursor', auto?.cursorHook === true);
    case 'hook:codex': return hook('codex', auto?.codexNotify === true && !codexAwaitsTrust(status));
    case 'hook:gemini-cli': return hook('gemini-cli', auto?.geminiHook === true);
    case 'schedule': return () => runSchedule({ remove: auto?.schedule === true, dryRun: false });
    case 'cursor-fetch': return () => runCursor(status?.cursorFetch === false ? 'on' : 'off');
    case 'claude-limits': return () => runLimits([status?.claudeLimits === true ? 'off' : 'on'], { json: false });
    case 'cursor-fetch-now': return () => runCursorFetchNow();
    case 'import-cursor': return importCursor;
    case 'export-csv': return () => exportFile('csv');
    case 'export-json': return () => exportFile('json');
    // The story cards have their own box (story-session.ts); the story command draws on the terminal itself.
    case 'story': return async () => (console.error('Story cards open in their own box.'), 1);
    case 'status': return () => runStatus({}, { json: false });
    case 'uninstall': return () => runUninstall({ purge: false, yes: false, dryRun: false });
    case 'update': return () => runUpdate({ yes: false });
  }
}

/** Runs an `inline` action behind the view and returns its output for a toast. */
export function runAction(id: ActionId, status: SetupStatus | null): Promise<ActionResult> {
  return captureOutput(command(id, status));
}

/**
 * Login in the task box: Esc stops the wait for GitHub's approval, and the global install login may offer (from
 * an npx copy) prints into the box instead of onto the terminal.
 */
async function login(context: TaskContext): Promise<number> {
  const { offerSchedule, runWithThisNode } = await import('../commands/login-finish.js');
  return runLogin(
    { method: 'auto', openBrowser: true, signal: context.signal },
    {
      pollForToken: async (code, signal) => {
        context.cancellable(true);
        context.busy('Waiting for you to approve tokengraph on GitHub…');
        try {
          const token = await pollForToken(code, signal ? { signal } : {});
          // Esc pressed as the approval arrived: the person asked to stop, so nothing is stored.
          if (signal?.aborted) throw new DeviceFlowError('cancelled');
          return token;
        } finally {
          context.busy(null);
          context.cancellable(false);
        }
      },
      offerSchedule: () =>
        offerSchedule({
          install: (version) => installGlobally(version, context.print),
          runInstalled: (bin, args) => runWithThisNode(bin, args, context.print),
        }),
    },
  );
}

/** A finished install replaced the code on disk, so the view must start again instead of running on with the old one. */
async function update(context: TaskContext): Promise<TaskOutcome> {
  const before = cliVersion();
  const code = await runUpdate({ yes: false }, { install: (version) => installGlobally(version, context.print) });
  return { code, after: code === 0 && cliVersion() !== before ? 'restart' : 'reload' };
}

/** With the data deleted there is nothing left to show, and a rescan would write a new ledger: the view quits. */
async function uninstall(): Promise<TaskOutcome> {
  const purge = await askYesNo('Also delete your tokengraph data?', { defaultYes: false });
  const code = await runUninstall({ purge, yes: false, dryRun: false });
  const gone = purge && !existsSync(configPath()) && !existsSync(ledgerPath());
  return { code, after: gone ? 'quit' : 'reload' };
}

/** The command behind a `task` action, as the task box runs it (see task-session.ts). */
export function taskRun(id: ActionId, status: SetupStatus | null): TaskRun {
  return async (context) => {
    switch (id) {
      case 'login': return { code: await login(context) };
      case 'update': return update(context);
      case 'uninstall': return uninstall();
      default: return { code: await command(id, status)() };
    }
  };
}
