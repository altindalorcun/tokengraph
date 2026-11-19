import type { HookAgent } from '../commands/install-hook.js';
import type { GraphColors } from '../config.js';
import type { AutoSyncStatus, CodexSetup } from './auto-sync.js';

export type { HookAgent };
export type ActionId =
  | 'sync' | 'login' | 'logout' | 'readme' | 'colors'
  | 'hook:claude-code' | 'hook:cursor' | 'hook:codex' | 'hook:gemini-cli' | 'schedule'
  | 'cursor-fetch-now' | 'cursor-fetch' | 'import-cursor'
  | 'export-csv' | 'export-json' | 'story' | 'status' | 'uninstall' | 'update';
export type ActionSection = 'Account' | 'Auto-sync' | 'Cursor' | 'Your data' | 'Updates';

/** What the action list needs to know about this machine; read from the config and the installed hooks. */
export interface SetupStatus {
  login: string | null;
  autoSync: AutoSyncStatus | null;
  cursorFetch: boolean | null;
  graphColors: GraphColors;
  /** This copy's version and the newer one the last check found, if any. */
  update: { current: string; latest: string | null } | null;
}

export interface ActionItem {
  id: ActionId;
  section: ActionSection;
  title: string;
  detail: string;
  /** Only toggles have a state; null for plain actions. */
  state: 'on' | 'off' | 'unknown' | null;
  /**
   * `inline` runs behind the view and reports with a toast; `task` runs the command in the task box, which shows its
   * output and asks its questions; `panel` opens its own box (the story cards). None of them leaves the view.
   */
  kind: 'inline' | 'task' | 'panel';
  confirm: string | null;
  recommended: boolean;
  /** Graph colours only: the mode the action switches to. */
  next?: GraphColors;
  /** On, but pressing it installs again rather than removing: the Codex hook while Codex has not trusted it (shows the steps). */
  reinstall?: boolean;
}

interface HookDef {
  agent: HookAgent;
  title: string;
  name: string;
  /** The ledger source this hook syncs. */
  source: string;
  field: Exclude<keyof AutoSyncStatus, 'codex'>;
}

const HOOKS: readonly HookDef[] = [
  { agent: 'claude-code', title: 'Claude Code hook', name: 'Claude Code', source: 'claude-code', field: 'claudeHook' },
  { agent: 'cursor', title: 'Cursor hook', name: 'Cursor', source: 'cursor', field: 'cursorHook' },
  { agent: 'codex', title: 'Codex hook', name: 'Codex', source: 'codex-cli', field: 'codexNotify' },
  { agent: 'gemini-cli', title: 'Gemini CLI hook', name: 'Gemini CLI', source: 'gemini-cli', field: 'geminiHook' },
];

type ToggleState = 'on' | 'off' | 'unknown';

function toggleState(value: boolean | null | undefined): ToggleState {
  return value === true ? 'on' : value === false ? 'off' : 'unknown';
}

function task(id: ActionId, section: ActionSection, title: string, detail: string): ActionItem {
  return { id, section, title, detail, state: null, kind: 'task', confirm: null, recommended: false };
}

/** Which Codex mechanism the item uses or would use, in a few words. */
function codexDetail(codex: CodexSetup | null | undefined): string {
  if (!codex) return 'sync after each turn';
  if (codex.via === 'notify') return 'sync after each turn (notify)';
  if (codex.via === 'hook') {
    if (codex.approval === 'pending') return 'trust it in Codex (Enter for steps)';
    if (codex.approval === 'disabled') return 'turned off in Codex (Enter for steps)';
    return 'sync after each turn (Stop hook)';
  }
  if (codex.blocked) return 'notify taken, hooks off: use hourly sync';
  return codex.notifyTaken ? 'notify is taken: adds a Stop hook' : 'sync after each turn (notify)';
}

/** Codex can take neither our notify (another program holds it) nor a hook (turned off): only the hourly sync covers it. */
function codexBlocked(status: SetupStatus | null): boolean {
  return Boolean(status?.autoSync?.codex?.blocked);
}

/** Installed, but Codex does not run it yet (a hook Codex has not trusted, or one turned off in Codex). */
export function codexAwaitsTrust(status: SetupStatus | null): boolean {
  const codex = status?.autoSync?.codex;
  return codex?.via === 'hook' && codex.approval !== 'approved';
}

/** A hook this machine can use: every hook but Codex's when Codex is blocked. */
function usable(def: HookDef, status: SetupStatus | null): boolean {
  return def.agent !== 'codex' || !codexBlocked(status);
}

/**
 * An unknown state counts as not installed: the toggle installs, it never removes what it cannot see. The Codex
 * item runs in the task box, since what it prints (the steps to trust the hook in Codex) is the point; while Codex
 * has not trusted the hook, pressing it shows those steps again instead of removing it.
 */
function hookItem(def: HookDef, status: SetupStatus | null, used: readonly string[]): ActionItem {
  const state = toggleState(status?.autoSync?.[def.field]);
  const codex = def.agent === 'codex';
  const reinstall = codex && state === 'on' && codexAwaitsTrust(status);
  return {
    id: `hook:${def.agent}`,
    section: 'Auto-sync',
    title: def.title,
    detail: codex ? codexDetail(status?.autoSync?.codex) : 'sync when a session ends',
    state,
    kind: codex ? 'task' : 'inline',
    confirm: reinstall ? null : state === 'on' ? `Remove the ${def.title}?` : `Install the ${def.title}? It edits ${def.name}'s settings.`,
    recommended: state !== 'on' && used.includes(def.source) && usable(def, status),
    ...(reinstall ? { reinstall } : {}),
  };
}

/** Sources that have no usable hook of their own and rely on the hourly sync. */
function needsSchedule(used: readonly string[], status: SetupStatus | null): boolean {
  return used.some((source) => !HOOKS.some((def) => def.source === source && usable(def, status)));
}

/** The actions the terminal view offers, grouped by section in display order. */
export function actionItems(status: SetupStatus | null, usedSources: readonly string[]): ActionItem[] {
  const login = status?.login ?? null;
  const items: ActionItem[] = [];
  if (login === null) {
    items.push({ ...task('login', 'Account', 'Connect GitHub', 'publish your graph to your own gist'), recommended: true });
    items.push(task('sync', 'Account', 'Sync now', 'read your agents; publishes nothing'));
  } else {
    items.push(task('sync', 'Account', 'Sync and publish now', 'update your gist graph'));
    items.push(task('readme', 'Account', 'Copy the README snippet', 'show your graph in a GitHub README'));
    const single = status?.graphColors === 'single';
    items.push({ ...task('colors', 'Account', 'Graph colours', single ? 'single colour' : 'by model family'), next: single ? 'model' : 'single' });
    items.push(task('logout', 'Account', `Disconnect @${login}`, 'forget the login on this machine'));
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
    recommended: schedule !== 'on' && needsSchedule(usedSources, status),
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
  items.push(task('cursor-fetch-now', 'Cursor', 'Fetch Cursor usage now', 'ask cursor.com once'));
  items.push(task('import-cursor', 'Cursor', 'Import a Cursor usage CSV', 'from the Cursor dashboard'));

  items.push({ ...task('story', 'Your data', 'Make story cards', 'images to share'), kind: 'panel' });
  items.push(task('export-csv', 'Your data', 'Export as CSV', 'one row per day, agent and model'));
  items.push(task('export-json', 'Your data', 'Export as JSON', 'one row per day, agent and model'));
  items.push(task('status', 'Your data', 'Show status', 'account, ledger and background syncs'));
  items.push(task('uninstall', 'Your data', 'Uninstall tokengraph', 'remove the hooks and the schedule'));

  // No confirmation here: `tokengraph update` shows the exact command and asks in the task box.
  const update = status?.update ?? null;
  items.push({
    ...task('update', 'Updates', update?.latest ? `Update to ${update.latest}` : 'Check for updates', update ? `you have ${update.current}` : 'ask npm for a newer version'),
    recommended: Boolean(update?.latest),
  });
  return items;
}

function unreachable(id: never): never {
  throw new Error(`no command for action ${String(id)}`);
}

/** The command line that does what the item does now (a toggle shows the direction it would flip). */
export function cliCommand(item: ActionItem): string {
  const on = item.state === 'on' && !item.reinstall;
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
    case 'update': return 'tokengraph update';
  }
  return unreachable(item.id);
}

/** Setup steps done out of those that apply: GitHub, one hook per agent in use that can take one, and the hourly sync for the rest. */
export function setupProgress(
  items: readonly ActionItem[],
  status: SetupStatus | null,
  usedSources: readonly string[],
): { done: number; total: number } {
  const on = (id: ActionId): boolean => items.find((item) => item.id === id)?.state === 'on';
  const hooks = HOOKS.filter((def) => usedSources.includes(def.source) && usable(def, status));
  const schedule = needsSchedule(usedSources, status);
  const total = 1 + hooks.length + (schedule ? 1 : 0);
  // A Codex hook still waiting for approval in Codex does not sync yet, so that step is not done.
  const working = (def: HookDef) => on(`hook:${def.agent}`) && !(def.agent === 'codex' && codexAwaitsTrust(status));
  const done = (status?.login ? 1 : 0) + hooks.filter(working).length + (schedule && on('schedule') ? 1 : 0);
  return { done, total };
}
