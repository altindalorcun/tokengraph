import { describe, expect, it } from 'vitest';
import {
  addHook,
  eventsWithHook,
  hasHook,
  isTokenGraphHookCommand,
  matchingCommands,
  removeHook,
  type Settings,
} from '../src/hook-settings.js';

const BIN = '/Users/x/codes/token-graph/packages/cli/dist/bin.js';
const COMMAND = `"/opt/homebrew/opt/node/bin/node" "${BIN}" hook-sync`;
const OLD = `"/opt/homebrew/Cellar/node/25.2.1/bin/node" "${BIN}" sync --since 30 >/dev/null 2>&1 || true`;
const OLD_EDITED = `"/opt/homebrew/Cellar/node/25.2.1/bin/node" "${BIN}" sync --since 30 </dev/null >/dev/null 2>&1 &`;
const isOurs = isTokenGraphHookCommand;
const add = (s: Settings, event = 'SessionEnd') => addHook(s, event, COMMAND, isOurs);
const remove = (s: Settings, event = 'SessionEnd') => removeHook(s, event, isOurs);
const on = (command: string) => ({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command }] }] } });

describe('isTokenGraphHookCommand', () => {
  it('recognises the old, hand-edited and new forms', () => {
    expect(isOurs(OLD)).toBe(true);
    expect(isOurs(OLD_EDITED)).toBe(true);
    expect(isOurs(COMMAND)).toBe(true);
  });

  it('recognises a Windows npm-global install', () => {
    const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\token-graph\\dist\\bin.js" hook-sync';
    expect(isOurs(cmd)).toBe(true);
  });

  it('recognises a global install of the published tokengraph package', () => {
    expect(isOurs('"/usr/local/bin/node" "/usr/local/lib/node_modules/tokengraph/bundle/bin.js" hook-sync')).toBe(true);
    expect(isOurs('"/usr/bin/node" "/x/tokengraph/bundle/bin.js" hook-sync --min-interval 600')).toBe(true);
  });

  it('never matches other tools', () => {
    expect(isOurs('"node" "/x/other/bin.js" sync --since 30')).toBe(false);
    expect(isOurs('other-tool')).toBe(false);
    expect(isOurs(`"node" "${BIN}" cursor-hook`)).toBe(false);
    expect(isOurs(`"node" "${BIN}" status`)).toBe(false);
  });
});

describe('addHook', () => {
  it('adds the hook to settings that have none', () => {
    expect(hasHook(add({}), 'SessionEnd', COMMAND)).toBe(true);
  });

  it('preserves every unrelated setting', () => {
    const settings: Settings = { theme: 'dark', model: 'opus', enabledPlugins: { a: true } };
    expect(add(settings)).toMatchObject({ theme: 'dark', model: 'opus', enabledPlugins: { a: true } });
  });

  it('preserves hooks belonging to other tools, with matchers and order', () => {
    const settings: Settings = {
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook' }] }],
      },
    };
    const result = add(settings) as { hooks: Record<string, unknown> };
    expect(result.hooks['PreToolUse']).toEqual((settings['hooks'] as Record<string, unknown>)['PreToolUse']);
    expect(result.hooks['SessionEnd']).toEqual([
      { hooks: [{ type: 'command', command: 'other-tool' }] },
      { hooks: [{ type: 'command', command: COMMAND }] },
    ]);
  });

  it('is idempotent so repeated installs do not stack up', () => {
    const once = add({});
    expect(add(once)).toBe(once);
  });

  it('does not mutate the settings it was given', () => {
    const settings = on(OLD);
    const copy = structuredClone(settings);
    add(settings);
    expect(settings).toEqual(copy);
  });

  it('replaces an old-form hook instead of duplicating it', () => {
    const result = add(on(OLD));
    expect(matchingCommands(result, 'SessionEnd', isOurs)).toEqual([COMMAND]);
    expect(hasHook(result, 'SessionEnd', OLD)).toBe(false);
  });

  it('collapses several legacy copies into one new hook and keeps neighbours in a shared matcher', () => {
    const settings: Settings = {
      hooks: {
        SessionEnd: [
          { matcher: 'x', hooks: [{ type: 'command', command: OLD }, { type: 'command', command: 'keep' }] },
          { hooks: [{ type: 'command', command: OLD_EDITED }] },
        ],
      },
    };
    const result = add(settings) as { hooks: { SessionEnd: unknown[] } };
    expect(result.hooks.SessionEnd).toEqual([
      { matcher: 'x', hooks: [{ type: 'command', command: 'keep' }] },
      { hooks: [{ type: 'command', command: COMMAND }] },
    ]);
  });

  it('collapses the new command plus a legacy copy into one', () => {
    const settings: Settings = {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: COMMAND }, { type: 'command', command: OLD }] }] },
    };
    expect(matchingCommands(add(settings), 'SessionEnd', isOurs)).toEqual([COMMAND]);
  });
});

describe('removeHook', () => {
  it('removes only our hooks', () => {
    const settings = add(on('other-tool'));
    const result = remove(settings);
    expect(matchingCommands(result, 'SessionEnd', isOurs)).toEqual([]);
    expect(hasHook(result, 'SessionEnd', 'other-tool')).toBe(true);
  });

  it('removes old-form hooks', () => {
    expect(remove({ theme: 'dark', ...on(OLD_EDITED) })).toEqual({ theme: 'dark' });
    expect(remove(on(OLD))).toEqual({});
  });

  it('cleans up the empty event and hooks keys it leaves behind', () => {
    expect(remove(add({ theme: 'dark' }))).toEqual({ theme: 'dark' });
  });

  it('leaves settings untouched when the hook is not installed', () => {
    const settings: Settings = { theme: 'dark' };
    expect(remove(settings)).toBe(settings);
  });
});

describe('eventsWithHook', () => {
  it('finds our hooks on other events only', () => {
    const settings: Settings = {
      hooks: { ...on(COMMAND).hooks, Stop: [{ hooks: [{ type: 'command', command: OLD }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    };
    expect(eventsWithHook(settings, isOurs, 'SessionEnd')).toEqual(['Stop']);
  });
});

describe('hasHook', () => {
  it('tolerates malformed settings instead of throwing', () => {
    expect(hasHook({ hooks: 'nope' }, 'SessionEnd', COMMAND)).toBe(false);
    expect(hasHook({ hooks: { SessionEnd: 'nope' } }, 'SessionEnd', COMMAND)).toBe(false);
    expect(hasHook({ hooks: { SessionEnd: [{}] } }, 'SessionEnd', COMMAND)).toBe(false);
    expect(add({ hooks: { SessionEnd: [{}] } })).toBeTruthy();
  });
});
