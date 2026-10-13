import { describe, expect, it } from 'vitest';
import {
  addCursorHook,
  hasCursorHook,
  isTokenGraphCursorHookCommand,
  removeCursorHook,
} from '../src/cursor-hooks-json.js';

const BIN = '/Users/x/codes/token-graph/packages/cli/dist/bin.js';
const COMMAND = `"/opt/homebrew/opt/node/bin/node" "${BIN}" cursor-hook`;
const OLD = `"/opt/homebrew/Cellar/node/25.2.1/bin/node" "${BIN}" cursor-hook`;
const isOurs = isTokenGraphCursorHookCommand;
const add = (f: Record<string, unknown>) => addCursorHook(f, COMMAND, isOurs);
const remove = (f: Record<string, unknown>) => removeCursorHook(f, isOurs);

describe('isTokenGraphCursorHookCommand', () => {
  it('matches any node path but only token-graph bins', () => {
    expect(isOurs(COMMAND)).toBe(true);
    expect(isOurs(OLD)).toBe(true);
    expect(isOurs('"C:\\Program Files\\nodejs\\node.exe" "C:\\u\\npm\\node_modules\\token-graph\\dist\\bin.js" cursor-hook')).toBe(true);
    expect(isOurs('"node" "/x/other/bin.js" cursor-hook')).toBe(false);
    expect(isOurs(`"node" "${BIN}" hook-sync`)).toBe(false);
    expect(isOurs('other-tool')).toBe(false);
  });
});

describe('addCursorHook', () => {
  it('creates a version 1 file with a stop hook', () => {
    expect(add({})).toEqual({ version: 1, hooks: { stop: [{ command: COMMAND }] } });
  });

  it('preserves other events, other stop hooks and unrelated keys', () => {
    const file = {
      version: 1,
      custom: true,
      hooks: { stop: [{ command: 'other-tool' }], beforeShellExecution: [{ command: 'guard' }] },
    };
    expect(add(file)).toEqual({
      version: 1,
      custom: true,
      hooks: { stop: [{ command: 'other-tool' }, { command: COMMAND }], beforeShellExecution: [{ command: 'guard' }] },
    });
  });

  it('returns the same object when the hook is already installed', () => {
    const file = add({});
    expect(add(file)).toBe(file);
    expect(hasCursorHook(file, COMMAND)).toBe(true);
  });

  it('replaces an old-form hook and collapses duplicates', () => {
    const file = { version: 1, hooks: { stop: [{ command: OLD }, { command: 'other-tool' }, { command: OLD }] } };
    expect(add(file)).toEqual({ version: 1, hooks: { stop: [{ command: 'other-tool' }, { command: COMMAND }] } });
  });
});

describe('removeCursorHook', () => {
  it('removes only the token-graph stop hooks, including old forms', () => {
    const file = { version: 1, hooks: { stop: [{ command: 'other-tool' }, { command: COMMAND }, { command: OLD }] } };
    expect(remove(file)).toEqual({ version: 1, hooks: { stop: [{ command: 'other-tool' }] } });
  });

  it('drops an emptied stop list but keeps the file valid', () => {
    expect(remove(add({}))).toEqual({ version: 1, hooks: {} });
  });

  it('returns the same object when the hook is not installed', () => {
    const file = { version: 1, hooks: { stop: [{ command: 'other-tool' }] } };
    expect(remove(file)).toBe(file);
  });
});
