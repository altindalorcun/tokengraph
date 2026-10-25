import type { HookAgent } from '../commands/install-hook.js';
import type { GraphColors } from '../config.js';
import type { AutoSyncStatus } from './auto-sync.js';

export type { HookAgent };
export type ActionId =
  | 'sync' | 'login' | 'logout' | 'readme' | 'colors'
  | 'hook:claude-code' | 'hook:cursor' | 'hook:codex' | 'hook:gemini-cli' | 'schedule'
  | 'cursor-fetch-now' | 'cursor-fetch' | 'import-cursor'
  | 'export-csv' | 'export-json' | 'story' | 'status' | 'uninstall';
export type ActionSection = 'Account' | 'Auto-sync' | 'Cursor' | 'Your data';

/** What the action list needs to know about this machine; read from the config and the installed hooks. */
export interface SetupStatus {
  login: string | null;
  autoSync: AutoSyncStatus | null;
  cursorFetch: boolean | null;
  graphColors: GraphColors;
}

export interface ActionItem {
  id: ActionId;
  section: ActionSection;
  title: string;
  detail: string;
  /** Only toggles have a state; null for plain actions. */
  state: 'on' | 'off' | 'unknown' | null;
  /** `inline` runs behind the TUI and reports with a toast; `screen` hands the terminal to the command. */
  kind: 'inline' | 'screen';
  confirm: string | null;
  recommended: boolean;
  /** Graph colours only: the mode the action switches to. */
  next?: GraphColors;
}

interface HookDef {
  agent: HookAgent;
  title: string;
  name: string;
  /** The ledger source this hook syncs. */
  source: string;
  field: keyof AutoSyncStatus;
}

const HOOKS: readonly HookDef[] = [
  { agent: 'claude-code', title: 'Claude Code hook', name: 'Claude Code', source: 'claude-code', field: 'claudeHook' },
  { agent: 'cursor', title: 'Cursor hook', name: 'Cursor', source: 'cursor', field: 'cursorHook' },
  { agent: 'codex', title: 'Codex notify', name: 'Codex', source: 'codex-cli', field: 'codexNotify' },
  { agent: 'gemini-cli', title: 'Gemini CLI hook', name: 'Gemini CLI', source: 'gemini-cli', field: 'geminiHook' },
];

type ToggleState = 'on' | 'off' | 'unknown';

function toggleState(value: boolean | null | undefined): ToggleState {
  return value === true ? 'on' : value === false ? 'off' : 'unknown';
}

function screen(id: ActionId, section: ActionSection, title: string, detail: string): ActionItem {
  return { id, section, title, detail, state: null, kind: 'screen', confirm: null, recommended: false };
}

/** An unknown state counts as not installed: the toggle installs, it never removes what it cannot see. */
function hookItem(def: HookDef, status: SetupStatus | null, used: readonly string[]): ActionItem {
  const state = toggleState(status?.autoSync?.[def.field]);
  return {
    id: `hook:${def.agent}`,
    section: 'Auto-sync',
    title: def.title,
    detail: 'sync when a session ends',
    state,
    kind: 'inline',
    confirm: state === 'on' ? `Remove the ${def.title}?` : `Install the ${def.title}? It edits ${def.name}'s settings.`,
    recommended: state !== 'on' && used.includes(def.source),
  };
}

/** Sources that have no hook of their own and rely on the hourly sync. */
function needsSchedule(used: readonly string[]): boolean {
  return used.some((source) => !HOOKS.some((def) => def.source === source));
}

/** The actions the terminal view offers, grouped by section in display order. */
export function actionItems(status: SetupStatus | null, usedSources: readonly string[]): ActionItem[] {
  const login = status?.login ?? null;
  const items: ActionItem[] = [];
  if (login === null) {
    items.push({ ...screen('login', 'Account', 'Connect GitHub', 'publish your graph to your own gist'), recommended: true });
    items.push(screen('sync', 'Account', 'Sync now', 'read your agents; local only'));
  } else {
    items.push(screen('sync', 'Account', 'Sync and publish now', 'update your gist graph'));
    items.push(screen('readme', 'Account', 'Copy the README snippet', 'show your graph in a GitHub README'));
    const single = status?.graphColors === 'single';
    items.push({ ...screen('colors', 'Account', 'Graph colours', single ? 'single colour' : 'by model family'), next: single ? 'model' : 'single' });
    items.push(screen('logout', 'Account', `Disconnect @${login}`, 'forget the login on this machine'));
  }

  for (const def of HOOKS) items.push(hookItem(def, status, usedSources));
  const schedule = toggleState(status?.autoSync?.schedule);
  items.push({
    id: 'schedule',
    section: 'Auto-sync',
    title: 'Hourly sync',
    detail: 'every agent, in the background',
    state: schedule,
    kind: 'inline',
    confirm: schedule === 'on' ? 'Turn off the hourly sync?' : 'Turn on the hourly sync?',
    recommended: schedule !== 'on' && needsSchedule(usedSources),
  });

  const fetching = status?.cursorFetch !== false;
  items.push({
    id: 'cursor-fetch',
    section: 'Cursor',
    title: 'Cursor history from cursor.com',
    detail: "uses Cursor's own sign-in",
    state: fetching ? 'on' : 'off',
    kind: 'inline',
    confirm: fetching ? 'Stop fetching your Cursor history from cursor.com?' : null,
    recommended: false,
  });
  items.push(screen('cursor-fetch-now', 'Cursor', 'Fetch Cursor usage now', 'ask cursor.com once'));
  items.push(screen('import-cursor', 'Cursor', 'Import a Cursor usage CSV', 'from the Cursor dashboard'));

  items.push(screen('story', 'Your data', 'Make story cards', 'images to share'));
  items.push(screen('export-csv', 'Your data', 'Export as CSV', 'one row per day, agent and model'));
  items.push(screen('export-json', 'Your data', 'Export as JSON', 'one row per day, agent and model'));
  items.push(screen('status', 'Your data', 'Show status', 'account, ledger and background syncs'));
  items.push(screen('uninstall', 'Your data', 'Uninstall tokengraph', 'remove the hooks and the schedule'));
  return items;
}

function unreachable(id: never): never {
  throw new Error(`no command for action ${String(id)}`);
}

/** The command line that does what the item does now (a toggle shows the direction it would flip). */
export function cliCommand(item: ActionItem): string {
  const on = item.state === 'on';
  const hook = (agent: HookAgent): string => `tokengraph install-hook --agent ${agent}${on ? ' --remove' : ''}`;
  switch (item.id) {
    case 'hook:claude-code': return hook('claude-code');
    case 'hook:cursor': return hook('cursor');
    case 'hook:codex': return hook('codex');
    case 'hook:gemini-cli': return hook('gemini-cli');
    case 'sync': return 'tokengraph sync';
    case 'login': return 'tokengraph login';
    case 'logout': return 'tokengraph logout';
    case 'readme': return 'tokengraph readme';
    case 'colors': return `tokengraph readme --colors ${item.next ?? 'single'}`;
    case 'schedule': return `tokengraph schedule${on ? ' --remove' : ''}`;
    case 'cursor-fetch': return `tokengraph cursor ${on ? 'off' : 'on'}`;
    case 'cursor-fetch-now': return 'tokengraph cursor fetch';
    case 'import-cursor': return 'tokengraph import cursor <file.csv>';
    case 'export-csv': return 'tokengraph export --format csv --out <file>';
    case 'export-json': return 'tokengraph export --format json --out <file>';
    case 'story': return 'tokengraph story';
    case 'status': return 'tokengraph status';
    case 'uninstall': return 'tokengraph uninstall';
  }
  return unreachable(item.id);
}

/** Setup steps done out of those that apply: GitHub, one hook per hook-capable agent in use, and the hourly sync for the rest. */
export function setupProgress(
  items: readonly ActionItem[],
  status: SetupStatus | null,
  usedSources: readonly string[],
): { done: number; total: number } {
  const on = (id: ActionId): boolean => items.find((item) => item.id === id)?.state === 'on';
  const hooks = HOOKS.filter((def) => usedSources.includes(def.source));
  const schedule = needsSchedule(usedSources);
  const total = 1 + hooks.length + (schedule ? 1 : 0);
  const done = (status?.login ? 1 : 0) + hooks.filter((def) => on(`hook:${def.agent}`)).length + (schedule && on('schedule') ? 1 : 0);
  return { done, total };
}
