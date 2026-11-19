import { describe, expect, it } from 'vitest';
import {
  addCodexHook,
  codexHookApproval,
  codexHookCommand,
  codexHookKey,
  codexHookPositions,
  codexHooksFileProblem,
  codexHooksOffReason,
  codexSupportsHooks,
  hooksFeatureOff,
  parseCodexVersion,
  removeCodexHook,
  removeCodexHookApprovals,
  codexTrustSteps,
  type CodexHooksFile,
} from '../src/codex-hooks.js';

const ARGS = ['/usr/local/bin/node', '/opt/lib/node_modules/tokengraph/bundle/bin.js', 'hook-sync', '--min-interval', '600'];
const OURS = codexHookCommand(ARGS);
const OLD = '"/old/node" "/opt/lib/node_modules/tokengraph/bundle/bin.js" hook-sync --min-interval 600';
const handler = (command: string) => ({ type: 'command', command, timeout: 30, statusMessage: 'tokengraph: sync usage' });
const FOREIGN = { hooks: [{ type: 'command', command: 'python3 ~/.codex/stop_check.py', timeout: 10 }] };

describe('codexHookCommand', () => {
  it('quotes the node and script paths and runs the same hook-sync as the notify', () => {
    expect(OURS).toBe('"/usr/local/bin/node" "/opt/lib/node_modules/tokengraph/bundle/bin.js" hook-sync --min-interval 600');
  });
});

describe('addCodexHook', () => {
  it('creates the Stop entry in an empty file', () => {
    expect(addCodexHook({}, OURS)).toEqual({ kind: 'written', file: { hooks: { Stop: [{ hooks: [handler(OURS)] }] } }, replacedOlder: false });
  });

  it('keeps other events, other Stop groups and the description, and appends after them', () => {
    const file: CodexHooksFile = { description: 'mine', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }], Stop: [FOREIGN] } };
    const edit = addCodexHook(file, OURS);
    expect(edit).toEqual({
      kind: 'written',
      file: { description: 'mine', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }], Stop: [FOREIGN, { hooks: [handler(OURS)] }] } },
      replacedOlder: false,
    });
    // The input is never mutated.
    expect(file).toEqual({ description: 'mine', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }], Stop: [FOREIGN] } });
  });

  it('is unchanged when ours is already there', () => {
    expect(addCodexHook({ hooks: { Stop: [FOREIGN, { hooks: [handler(OURS)] }] } }, OURS)).toEqual({ kind: 'unchanged' });
  });

  it('refreshes an older command in place, so its position (Codex trust key) stays, and keeps fields the user added', () => {
    const file = { hooks: { Stop: [{ hooks: [{ ...handler(OLD), async: false }] }, FOREIGN] } };
    expect(addCodexHook(file, OURS)).toEqual({
      kind: 'written',
      file: { hooks: { Stop: [{ hooks: [{ ...handler(OURS), async: false }] }, FOREIGN] } },
      replacedOlder: true,
    });
  });

  it('drops duplicate copies of ours while keeping the first', () => {
    const file = { hooks: { Stop: [{ hooks: [handler(OLD)] }, FOREIGN, { hooks: [handler(OURS)] }] } };
    const edit = addCodexHook(file, OURS);
    expect(edit).toMatchObject({ kind: 'written', file: { hooks: { Stop: [{ hooks: [handler(OURS)] }, FOREIGN] } } });
  });
});

describe('removeCodexHook', () => {
  it('is unchanged without ours, and never touches foreign hooks', () => {
    expect(removeCodexHook({})).toEqual({ kind: 'unchanged' });
    expect(removeCodexHook({ hooks: { Stop: [FOREIGN] } })).toEqual({ kind: 'unchanged' });
  });

  it('leaves nothing when the file only held ours', () => {
    expect(removeCodexHook({ hooks: { Stop: [{ hooks: [handler(OURS)] }] } })).toEqual({ kind: 'written', file: null, replacedOlder: false });
  });

  it('removes only ours, dropping our trailing group', () => {
    const edit = removeCodexHook({ description: 'd', hooks: { Stop: [FOREIGN, { hooks: [handler(OURS)] }], SessionStart: [FOREIGN] } });
    expect(edit).toEqual({ kind: 'written', file: { description: 'd', hooks: { Stop: [FOREIGN], SessionStart: [FOREIGN] } }, replacedOlder: false });
  });

  it('leaves an empty group where ours was when groups follow it, so their positions and approvals stay', () => {
    const edit = removeCodexHook({ hooks: { Stop: [{ hooks: [handler(OURS)] }, FOREIGN] } });
    expect(edit).toMatchObject({ kind: 'written', file: { hooks: { Stop: [{ hooks: [] }, FOREIGN] } } });
  });

  it('takes ours out of a group it shares with another handler', () => {
    const shared = { hooks: [handler(OURS), FOREIGN.hooks[0]] };
    expect(removeCodexHook({ hooks: { Stop: [shared] } })).toMatchObject({ file: { hooks: { Stop: [{ hooks: [FOREIGN.hooks[0]] }] } } });
  });

  it('does not count a tokengraph command on another event as ours', () => {
    expect(removeCodexHook({ hooks: { SessionStart: [{ hooks: [handler(OURS)] }] } })).toEqual({ kind: 'unchanged' });
  });
});

describe('codexHooksFileProblem', () => {
  it('accepts the shapes Codex reads and names what it refuses', () => {
    expect(codexHooksFileProblem({})).toBeNull();
    expect(codexHooksFileProblem({ hooks: { Stop: [FOREIGN] } })).toBeNull();
    expect(codexHooksFileProblem([])).toMatch(/JSON object/);
    expect(codexHooksFileProblem({ hooks: [] })).toMatch(/"hooks" is not an object/);
    expect(codexHooksFileProblem({ hooks: { Stop: {} } })).toMatch(/not a list/);
    expect(codexHooksFileProblem({ hooks: { Stop: ['x'] } })).toMatch(/not an object/);
    expect(codexHooksFileProblem({ hooks: { Stop: [{ hooks: 'x' }] } })).toMatch(/"hooks" is not a list/);
  });
});

describe('codexHookApproval', () => {
  const path = '/Users/me/.codex/hooks.json';
  const key = codexHookKey(path, { group: 1, handler: 0 });

  it('builds the key the way Codex does', () => {
    expect(key).toBe('/Users/me/.codex/hooks.json:stop:1:0');
    expect(codexHookPositions({ hooks: { Stop: [FOREIGN, { hooks: [handler(OURS)] }] } })).toEqual([{ group: 1, handler: 0, command: OURS }]);
  });

  it('reads the approval Codex writes to config.toml', () => {
    // As codex-cli 0.155.1 writes it after /hooks (config/batchWrite of hooks.state).
    const toml = `model = "o3"\n\n[hooks.state]\n\n[hooks.state."${key}"]\ntrusted_hash = "sha256:d678"\n`;
    expect(codexHookApproval(toml, key)).toBe('approved');
    expect(codexHookApproval(toml, codexHookKey(path, { group: 0, handler: 0 }))).toBe('pending');
    expect(codexHookApproval('', key)).toBe('pending');
    expect(codexHookApproval(`[hooks.state."${key}"]\nenabled = false\ntrusted_hash = "sha256:d678"\n`, key)).toBe('disabled');
    // A later table is not part of it.
    expect(codexHookApproval(`[hooks.state."${key}"]\n[other]\ntrusted_hash = "sha256:d678"\n`, key)).toBe('pending');
  });
});

describe('hooks turned off', () => {
  it('reads [features] hooks = false and its older name', () => {
    expect(hooksFeatureOff('[features]\nhooks = false\n')).toBe(true);
    expect(hooksFeatureOff('[features]\ncodex_hooks = false\n')).toBe(true);
    expect(hooksFeatureOff('features.hooks = false\n')).toBe(true);
    expect(hooksFeatureOff('features = { hooks = false }\n')).toBe(true);
    expect(hooksFeatureOff('[features]\nhooks = true\n')).toBe(false);
    expect(hooksFeatureOff('[profiles.work.features]\nhooks = false\n')).toBe(false);
    expect(hooksFeatureOff('[features]\nhooks_extra = false\n')).toBe(false);
    expect(hooksFeatureOff('')).toBe(false);
  });

  it('names the reason, including managed requirements', () => {
    expect(codexHooksOffReason('[features]\nhooks = false\n', null)).toMatch(/config\.toml/);
    expect(codexHooksOffReason('', '[features]\nhooks = false\n')).toMatch(/administrator/);
    expect(codexHooksOffReason('', 'allow_managed_hooks_only = true\n')).toMatch(/allow_managed_hooks_only/);
    expect(codexHooksOffReason('', null)).toBeNull();
  });
});

describe('Codex version', () => {
  it('parses codex --version and knows the first release with hooks', () => {
    expect(parseCodexVersion('codex-cli 0.155.1\n')).toBe('0.155.1');
    expect(parseCodexVersion('nothing')).toBeNull();
    expect(codexSupportsHooks('0.155.1')).toBe(true);
    expect(codexSupportsHooks('0.124.0')).toBe(true);
    expect(codexSupportsHooks('0.123.9')).toBe(false);
    expect(codexSupportsHooks('1.0.0')).toBe(true);
  });
});

describe('removeCodexHookApprovals', () => {
  const key = '/Users/me/.codex/hooks.json:stop:0:0';
  const original = 'model = "gpt-5"\nnotify = ["say"]\n\n[model_providers.fake]\nname = "Fake"\n';

  it('undoes exactly what Codex 0.155.1 appends when a hook is approved', () => {
    const approved = `${original}\n[hooks.state]\n\n[hooks.state."${key}"]\ntrusted_hash = "sha256:c2ca"\n`;
    expect(removeCodexHookApprovals(approved, [key])).toBe(original);
  });

  it('keeps other hooks\' approvals and the [hooks.state] header they need', () => {
    const other = '[hooks.state."/Users/me/.codex/hooks.json:stop:1:0"]\ntrusted_hash = "sha256:ffff"\n';
    const approved = `${original}\n[hooks.state]\n\n[hooks.state."${key}"]\ntrusted_hash = "sha256:c2ca"\n\n${other}`;
    expect(removeCodexHookApprovals(approved, [key])).toBe(`${original}\n[hooks.state]\n\n${other}`);
  });

  it('removes a table in the middle and keeps what follows', () => {
    const text = `a = 1\n\n[hooks.state."${key}"]\nenabled = true\ntrusted_hash = "sha256:1"\n\n[tui]\nx = 1\n`;
    expect(removeCodexHookApprovals(text, [key])).toBe('a = 1\n\n[tui]\nx = 1\n');
  });

  it('leaves a table that holds anything but approval fields, and text without ours', () => {
    const text = `[hooks.state."${key}"]\ntrusted_hash = "sha256:1"\nnote = "mine"\n`;
    expect(removeCodexHookApprovals(text, [key])).toBe(text);
    expect(removeCodexHookApprovals(original, [key])).toBe(original);
    expect(removeCodexHookApprovals(original, [])).toBe(original);
  });
});

describe('adding the name', () => {
  it('refreshes a hook installed without its name, so /hooks no longer shows "Unnamed hook"', () => {
    const bare = { type: 'command', command: OURS, timeout: 30 };
    expect(addCodexHook({ hooks: { Stop: [{ hooks: [bare] }] } }, OURS)).toEqual({
      kind: 'written',
      file: { hooks: { Stop: [{ hooks: [handler(OURS)] }] } },
      replacedOlder: true,
    });
  });
});

describe('codexTrustSteps', () => {
  const text = (version: string | null) => codexTrustSteps(version).join('\n');

  it('walks a current Codex through the startup prompt, with /hooks as the fallback', () => {
    for (const version of [null, '0.131.0', '0.170.0']) {
      expect(text(version)).toContain('1. Quit Codex and open it again. It reads hooks when it starts.');
      expect(text(version)).toContain('2. When it asks "Hooks need review", press 2 ("Trust all and continue"), then Enter.');
      expect(text(version)).toContain('Enter alone does not trust it.');
      expect(text(version)).toContain('Missed it? Type /hooks in Codex, select Stop, press Enter, then t (trust), then Esc twice.');
      expect(text(version)).toContain('"tokengraph: sync usage"');
    }
  });

  it('uses /hooks before the prompt existed, and only a restart before trust existed', () => {
    expect(text('0.130.0')).not.toContain('Hooks need review');
    expect(text('0.130.0')).toContain('2. Type /hooks in Codex, select Stop, press Enter, then t (trust)');
    expect(text('0.124.0')).not.toContain('/hooks');
    expect(text('0.128.9')).toContain('without asking you to trust them');
  });
});
