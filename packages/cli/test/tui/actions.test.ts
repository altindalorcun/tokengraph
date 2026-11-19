import { describe, expect, it } from 'vitest';
import { actionItems, cliCommand, setupProgress, type SetupStatus } from '../../src/tui/actions.js';

const noHooks = { claudeHook: false, cursorHook: false, codexNotify: false, geminiHook: false, schedule: false };
const status = (patch: Partial<SetupStatus> = {}, autoSync: Partial<typeof noHooks> = {}): SetupStatus => ({
  login: null,
  autoSync: { ...noHooks, ...autoSync },
  cursorFetch: null,
  graphColors: 'model',
  ...patch,
});
const ids = (items: { id: string }[]) => items.map((item) => item.id);
const find = (items: ReturnType<typeof actionItems>, id: string) => items.find((item) => item.id === id)!;

describe('actionItems', () => {
  it('offers the Claude Code limits toggle under Plan limits', () => {
    const item = find(actionItems(status({ claudeLimits: true }), []), 'claude-limits');
    expect(item).toMatchObject({ section: 'Plan limits', title: 'Claude Code limits', state: 'on', kind: 'inline', recommended: false });
    expect(item.confirm).toBe('Put your old Claude Code status line back?');
    expect(cliCommand(item)).toBe('tokengraph limits off');
    const off = find(actionItems(status({ claudeLimits: false }), []), 'claude-limits');
    expect(off.state).toBe('off');
    expect(cliCommand(off)).toBe('tokengraph limits on');
    expect(find(actionItems(status(), []), 'claude-limits').state).toBe('unknown');
    const sections = [...new Set(actionItems(status(), []).map((i) => i.section))];
    expect(sections.indexOf('Plan limits')).toBe(sections.indexOf('Auto-sync') + 1);
  });

  it('offers login and a local sync while logged out', () => {
    const account = actionItems(status(), []).filter((item) => item.section === 'Account');
    expect(ids(account)).toEqual(['login', 'sync']);
    expect(account.map((item) => item.title)).toEqual(['Connect GitHub', 'Sync now']);
    expect(account.every((item) => item.kind === 'task' && item.confirm === null)).toBe(true);
  });

  it('offers publishing actions while logged in', () => {
    const items = actionItems(status({ login: 'orcun' }), []);
    const account = items.filter((item) => item.section === 'Account');
    expect(ids(account)).toEqual(['sync', 'readme', 'colors', 'logout']);
    expect(find(items, 'sync').title).toBe('Sync and publish now');
    expect(find(items, 'logout').title).toBe('Disconnect @orcun');
    expect(find(items, 'colors').detail).toBe('by model family');
    expect(find(actionItems(status({ login: 'orcun', graphColors: 'single' }), []), 'colors').detail).toBe('single colour');
  });

  it('keeps every section in order', () => {
    const items = actionItems(status({ login: 'o' }), []);
    expect(ids(items)).toEqual([
      'sync', 'readme', 'colors', 'logout',
      'hook:claude-code', 'hook:cursor', 'hook:codex', 'hook:gemini-cli', 'schedule',
      'claude-limits',
      'cursor-fetch', 'cursor-fetch-now', 'import-cursor',
      'story', 'export-csv', 'export-json', 'status', 'uninstall',
      'update',
    ]);
    expect(find(items, 'hook:codex').title).toBe('Codex hook');
  });

  it('offers an update only when a newer version is known, and hands the question to the command', () => {
    const idle = find(actionItems(status({ update: { current: '0.1.1', latest: null } }), []), 'update');
    expect(idle).toMatchObject({ title: 'Check for updates', detail: 'you have 0.1.1', recommended: false, kind: 'task', confirm: null });
    const ready = find(actionItems(status({ update: { current: '0.1.1', latest: '0.2.0' } }), []), 'update');
    expect(ready).toMatchObject({ title: 'Update to 0.2.0', detail: 'you have 0.1.1', recommended: true, kind: 'task', confirm: null });
    expect(cliCommand(ready)).toBe('tokengraph update');
  });

  it('maps hook state and words the confirmation', () => {
    const items = actionItems(status({}, { claudeHook: true, cursorHook: false, codexNotify: null }), []);
    expect(find(items, 'hook:claude-code')).toMatchObject({ state: 'on', kind: 'inline', confirm: 'Remove the Claude Code hook?' });
    expect(find(items, 'hook:cursor')).toMatchObject({ state: 'off', confirm: "Install the Cursor hook? It edits Cursor's settings." });
    expect(find(items, 'schedule')).toMatchObject({ state: 'off', confirm: 'Turn on the hourly sync?' });
    expect(find(actionItems(status({}, { schedule: true }), []), 'schedule').confirm).toBe('Turn off the hourly sync?');
  });

  it('treats an unknown hook as an install, never a removal', () => {
    const items = actionItems(status({}, { codexNotify: null, schedule: null }), []);
    expect(find(items, 'hook:codex')).toMatchObject({ state: 'unknown', confirm: "Install the Codex hook? It edits Codex's settings." });
    expect(find(items, 'schedule')).toMatchObject({ state: 'unknown', confirm: 'Turn on the hourly sync?' });
  });

  it('gives every section and unknown hooks without a status', () => {
    const items = actionItems(null, []);
    expect(new Set(items.map((item) => item.section))).toEqual(new Set(['Account', 'Auto-sync', 'Plan limits', 'Cursor', 'Your data', 'Updates']));
    for (const id of ['hook:claude-code', 'hook:cursor', 'hook:codex', 'hook:gemini-cli', 'schedule', 'claude-limits']) {
      expect(find(items, id).state).toBe('unknown');
    }
    expect(ids(items).slice(0, 2)).toEqual(['login', 'sync']);
  });

  it('maps the Cursor fetch toggle, confirming only when turning it off', () => {
    const off = find(actionItems(status({ cursorFetch: false }), []), 'cursor-fetch');
    expect(off).toMatchObject({ state: 'off', kind: 'inline', confirm: null });
    const on = find(actionItems(status({ cursorFetch: true }), []), 'cursor-fetch');
    expect(on.state).toBe('on');
    expect(on.confirm).not.toBeNull();
    expect(find(actionItems(status({ cursorFetch: null }), []), 'cursor-fetch').state).toBe('on');
  });

  it('recommends what the used agents need', () => {
    const items = actionItems(status(), ['claude-code']);
    expect(find(items, 'hook:claude-code').recommended).toBe(true);
    expect(find(items, 'hook:cursor').recommended).toBe(false);
    expect(find(items, 'login').recommended).toBe(true);
    expect(find(items, 'schedule').recommended).toBe(false);
    expect(find(actionItems(status({}, { claudeHook: true }), ['claude-code']), 'hook:claude-code').recommended).toBe(false);
    expect(find(actionItems(status({ login: 'o' }), ['claude-code']), 'logout').recommended).toBe(false);
  });

  it('recommends the schedule for sources without a hook of their own', () => {
    expect(find(actionItems(status(), ['claude-code', 'opencode']), 'schedule').recommended).toBe(true);
    expect(find(actionItems(status({}, { schedule: true }), ['opencode']), 'schedule').recommended).toBe(false);
    expect(find(actionItems(status(), ['codex-cli']), 'hook:codex').recommended).toBe(true);
  });
});

describe('setupProgress', () => {
  it('counts GitHub, one hook per used agent and the schedule', () => {
    const none = status();
    expect(setupProgress(actionItems(none, []), none, [])).toEqual({ done: 0, total: 1 });
    const used = ['claude-code', 'cursor', 'opencode'];
    expect(setupProgress(actionItems(none, used), none, used)).toEqual({ done: 0, total: 4 });
    const some = status({ login: 'o' }, { claudeHook: true, schedule: true });
    expect(setupProgress(actionItems(some, used), some, used)).toEqual({ done: 3, total: 4 });
  });

  it('counts nothing done without a status', () => {
    expect(setupProgress(actionItems(null, ['codex-cli']), null, ['codex-cli'])).toEqual({ done: 0, total: 2 });
  });
});

describe('the Codex item', () => {
  const codex = (patch: Record<string, unknown>) => ({ via: null, approval: null, notifyTaken: false, blocked: null, commands: [], ...patch });
  const withCodex = (patch: Record<string, unknown>, installed: boolean | null = false): SetupStatus =>
    status({ login: 'o' }, { codexNotify: installed, codex: codex(patch) } as never);
  const item = (s: SetupStatus, used = ['codex-cli']) => find(actionItems(s, used), 'hook:codex');

  it('says which mechanism it uses or would use', () => {
    expect(item(withCodex({})).detail).toBe('sync after each turn (notify)');
    expect(item(withCodex({ notifyTaken: true })).detail).toBe('notify is taken: adds a Stop hook');
    expect(item(withCodex({ via: 'notify' }, true)).detail).toBe('sync after each turn (notify)');
    expect(item(withCodex({ via: 'hook', approval: 'approved', notifyTaken: true }, true)).detail).toBe('sync after each turn (Stop hook)');
    expect(item(withCodex({ via: 'hook', approval: 'pending', notifyTaken: true }, true)).detail).toBe('trust it in Codex (Enter for steps)');
    expect(item(withCodex({ via: 'hook', approval: 'disabled' }, true)).detail).toBe('turned off in Codex (Enter for steps)');
    expect(item(status()).detail).toBe('sync after each turn');
  });

  it('is recommended while it can be installed, also when notify is taken', () => {
    expect(item(withCodex({ notifyTaken: true }))).toMatchObject({ state: 'off', recommended: true });
    expect(item(withCodex({ via: 'hook', approval: 'approved' }, true))).toMatchObject({ state: 'on', recommended: false, confirm: 'Remove the Codex hook?' });
  });

  it('is not recommended when neither mechanism can be used, and the hourly sync takes its place', () => {
    const blocked = withCodex({ notifyTaken: true, blocked: 'hooks are turned off in its config.toml ([features] hooks = false)' });
    expect(item(blocked)).toMatchObject({ state: 'off', recommended: false, detail: 'notify taken, hooks off: use hourly sync' });
    expect(find(actionItems(blocked, ['codex-cli']), 'schedule').recommended).toBe(true);
    expect(setupProgress(actionItems(blocked, ['codex-cli']), blocked, ['codex-cli'])).toEqual({ done: 1, total: 2 });
    // Usable: the Codex hook is the step, not the schedule.
    const free = withCodex({});
    expect(find(actionItems(free, ['codex-cli']), 'schedule').recommended).toBe(false);
    expect(setupProgress(actionItems(free, ['codex-cli']), free, ['codex-cli'])).toEqual({ done: 1, total: 2 });
  });

  it('runs in the task box, so its output (the steps) is shown in full', () => {
    expect(item(withCodex({ notifyTaken: true }))).toMatchObject({ kind: 'task', confirm: "Install the Codex hook? It edits Codex's settings." });
    expect(find(actionItems(withCodex({}), []), 'hook:claude-code').kind).toBe('inline');
  });

  it('shows the steps again instead of removing while Codex has not trusted the hook', () => {
    const pending = item(withCodex({ via: 'hook', approval: 'pending', notifyTaken: true }, true));
    expect(pending).toMatchObject({ state: 'on', confirm: null, reinstall: true, kind: 'task' });
    expect(cliCommand(pending)).toBe('tokengraph install-hook --agent codex');
    const working = item(withCodex({ via: 'hook', approval: 'approved' }, true));
    expect(working.reinstall).toBeUndefined();
    expect(cliCommand(working)).toBe('tokengraph install-hook --agent codex --remove');
  });

  it('counts a hook waiting for approval in Codex as installed but not yet done', () => {
    const pending = withCodex({ via: 'hook', approval: 'pending' }, true);
    expect(item(pending).state).toBe('on');
    expect(setupProgress(actionItems(pending, ['codex-cli']), pending, ['codex-cli'])).toEqual({ done: 1, total: 2 });
    const approved = withCodex({ via: 'hook', approval: 'approved' }, true);
    expect(setupProgress(actionItems(approved, ['codex-cli']), approved, ['codex-cli'])).toEqual({ done: 2, total: 2 });
    const notify = withCodex({ via: 'notify' }, true);
    expect(setupProgress(actionItems(notify, ['codex-cli']), notify, ['codex-cli'])).toEqual({ done: 2, total: 2 });
  });
});

describe('cliCommand', () => {
  const cmd = (items: ReturnType<typeof actionItems>, id: string) => cliCommand(find(items, id));

  it('names the command behind each action', () => {
    const out = actionItems(status({ login: 'orcun' }), []);
    expect(['sync', 'readme', 'logout', 'cursor-fetch-now', 'import-cursor', 'export-csv', 'export-json', 'story', 'status', 'uninstall'].map((id) => cmd(out, id))).toEqual([
      'tokengraph sync',
      'tokengraph readme',
      'tokengraph logout',
      'tokengraph cursor fetch',
      'tokengraph import cursor <file.csv>',
      'tokengraph export --format csv --out <file>',
      'tokengraph export --format json --out <file>',
      'tokengraph story',
      'tokengraph status',
      'tokengraph uninstall',
    ]);
    expect(cmd(actionItems(status(), []), 'login')).toBe('tokengraph login');
  });

  it('shows the direction a toggle would flip', () => {
    const off = actionItems(status({ login: 'orcun' }), []);
    expect(cmd(off, 'hook:codex')).toBe('tokengraph install-hook --agent codex');
    expect(cmd(off, 'schedule')).toBe('tokengraph schedule');
    expect(cmd(off, 'cursor-fetch')).toBe('tokengraph cursor off');
    expect(cmd(off, 'colors')).toBe('tokengraph readme --colors single');
    const on = actionItems(status({ login: 'orcun', cursorFetch: false, graphColors: 'single' }, { claudeHook: true, geminiHook: true, schedule: true }), []);
    expect(cmd(on, 'hook:claude-code')).toBe('tokengraph install-hook --agent claude-code --remove');
    expect(cmd(on, 'hook:gemini-cli')).toBe('tokengraph install-hook --agent gemini-cli --remove');
    expect(cmd(on, 'hook:cursor')).toBe('tokengraph install-hook --agent cursor');
    expect(cmd(on, 'schedule')).toBe('tokengraph schedule --remove');
    expect(cmd(on, 'cursor-fetch')).toBe('tokengraph cursor on');
    expect(cmd(on, 'colors')).toBe('tokengraph readme --colors model');
  });

  it('takes the colours direction from the status, not from the label', () => {
    const items = actionItems(status({ login: 'orcun', graphColors: 'single' }), []);
    expect(find(items, 'colors').next).toBe('model');
    expect(cliCommand({ ...find(items, 'colors'), detail: 'anything' })).toBe('tokengraph readme --colors model');
  });
});
