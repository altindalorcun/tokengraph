import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { format } from 'node:util';
import { runCursor, runCursorFetchNow } from '../commands/cursor.js';
import { runExport } from '../commands/export.js';
import { runImportCursor } from '../commands/import.js';
import { DEFAULT_HOOK_EVENT, runInstallHook, type HookAgent } from '../commands/install-hook.js';
import { runLogin } from '../commands/login.js';
import { runLogout } from '../commands/logout.js';
import { runReadme } from '../commands/readme.js';
import { runSchedule } from '../commands/schedule.js';
import { runStatus } from '../commands/status.js';
import { parseStoryArgs, runStory } from '../commands/story.js';
import { runSync } from '../commands/sync.js';
import { runUninstall } from '../commands/uninstall.js';
import { askText, askYesNo } from '../prompt.js';
import type { ActionId, SetupStatus } from './actions.js';

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

/** Reads one line from stdin in cooked mode; the answer is discarded. */
export async function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const closed = new Promise<void>((done) => rl.once('close', done));
    await Promise.race([rl.question(''), closed]);
  } finally {
    rl.close();
  }
}

function dateStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function exportFile(kind: 'csv' | 'json'): Promise<number> {
  const out = `tokengraph-${dateStamp()}.${kind}`;
  const code = await runExport({ format: kind, out });
  if (code === 0) console.log(`Wrote ${resolve(process.cwd(), out)}`);
  return code;
}

async function importCursor(): Promise<number> {
  const path = await askText('Path to the Cursor usage CSV (empty to cancel):');
  if (path === '') {
    console.log('Cancelled.');
    return 0;
  }
  return runImportCursor(path);
}

async function uninstall(): Promise<number> {
  const purge = await askYesNo('Also delete your tokengraph data?', { defaultYes: false });
  return runUninstall({ purge, yes: false, dryRun: false });
}

function hook(agent: HookAgent, installed: boolean): () => Promise<number> {
  return () => runInstallHook({ agent, event: DEFAULT_HOOK_EVENT, remove: installed, dryRun: false });
}

async function story(): Promise<number> {
  const options = parseStoryArgs({});
  if (typeof options === 'string') {
    console.error(options);
    return 1;
  }
  return runStory(options);
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
    case 'hook:codex': return hook('codex', auto?.codexNotify === true);
    case 'hook:gemini-cli': return hook('gemini-cli', auto?.geminiHook === true);
    case 'schedule': return () => runSchedule({ remove: auto?.schedule === true, dryRun: false });
    case 'cursor-fetch': return () => runCursor(status?.cursorFetch === false ? 'on' : 'off');
    case 'cursor-fetch-now': return () => runCursorFetchNow();
    case 'import-cursor': return importCursor;
    case 'export-csv': return () => exportFile('csv');
    case 'export-json': return () => exportFile('json');
    case 'story': return story;
    case 'status': return () => runStatus({}, { json: false });
    case 'uninstall': return uninstall;
  }
}

/** Runs an action's command. `inline` captures its output; `screen` lets it print and prompt on the real terminal. */
export async function runAction(id: ActionId, kind: 'inline' | 'screen', status: SetupStatus | null): Promise<ActionResult> {
  const run = command(id, status);
  if (kind === 'inline') return captureOutput(run);
  return { code: await run(), lines: [] };
}
