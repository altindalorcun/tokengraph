import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandPaths,
  cronProgramPaths,
  inspectAutoSync,
  plistProgramPaths,
  tokenGraphNotifyArgs,
} from '../src/auto-sync-health.js';
import { launchdPlist } from '../src/schedule-entries.js';

const NODE = '/usr/local/bin/node';
const BIN = '/usr/local/lib/node_modules/tokengraph/bundle/bin.js';
const HOOK = `"${NODE}" "${BIN}" hook-sync`;

/** The code builds paths with the host's separator; the fixtures are written with '/', so compare on that. */
const posix = (p: string) => p.replace(/\\/g, '/');

function deps(files: Record<string, string>, extra: Partial<NonNullable<Parameters<typeof inspectAutoSync>[0]>> = {}) {
  return {
    platform: 'darwin' as const,
    home: () => '/home/me',
    env: {},
    readText: async (p: string) => files[posix(p)] ?? null,
    exists: async (p: string) => posix(p) in files,
    crontab: async () => null,
    ...extra,
  };
}

describe('path extraction', () => {
  it('reads node and script from a hook command', () => {
    expect(commandPaths(HOOK)).toEqual([NODE, BIN]);
    expect(commandPaths('something else')).toEqual([]);
  });

  it('reads node and script from our plist', () => {
    expect(plistProgramPaths(launchdPlist([NODE, '/a & b/bin.js', 'sync'], '/log'))).toEqual([NODE, '/a & b/bin.js']);
  });

  it('reads node and script from our crontab line, old marker included', () => {
    expect(cronProgramPaths(`0 5 * * * backup\n17 * * * * "${NODE}" "/x/50\\%/bin.js" sync >> "/l" 2>&1 # tokengraph-sync\n`)).toEqual([
      NODE,
      '/x/50%/bin.js',
    ]);
    expect(cronProgramPaths(`17 * * * * "${NODE}" "${BIN}" sync # token-graph-sync`)).toEqual([NODE, BIN]);
    expect(cronProgramPaths('0 5 * * * backup')).toEqual([]);
  });

  it('reads our Codex notify and ignores anyone else’s', () => {
    expect(tokenGraphNotifyArgs(`notify = ["${NODE}", "${BIN}", "hook-sync", "--min-interval", "600"]\n`)).toEqual([
      NODE,
      BIN,
      'hook-sync',
      '--min-interval',
      '600',
    ]);
    expect(tokenGraphNotifyArgs('notify = ["/usr/bin/say", "done"]')).toBeNull();
    expect(tokenGraphNotifyArgs(`[tui]\nnotify = ["${NODE}", "${BIN}", "hook-sync"]`)).toBeNull();
  });
});

describe('inspectAutoSync', () => {
  it('reports healthy installs with where they live', async () => {
    const health = await inspectAutoSync(
      deps({
        '/home/me/.claude/settings.json': JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: HOOK }] }] } }),
        '/home/me/Library/LaunchAgents/dev.tokengraph.sync.plist': launchdPlist([NODE, BIN, 'sync'], '/log'),
        [NODE]: '',
        [BIN]: '',
      }),
    );
    expect(health.claudeHook).toEqual({ installed: true, detail: 'SessionEnd', missing: [] });
    expect(health.schedule).toEqual({ installed: true, missing: [] });
    expect(health.cursorHook).toEqual({ installed: false, missing: [] });
    expect(health.codexNotify).toEqual({ installed: false, missing: [] });
  });

  it('lists the paths a broken install still points at', async () => {
    const oldNode = '/Users/me/.nvm/versions/node/v20.0.0/bin/node';
    const health = await inspectAutoSync(
      deps({
        '/home/me/.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { stop: [{ command: `"${oldNode}" "${BIN}" cursor-hook` }] } }),
        '/home/me/.codex/config.toml': `notify = ["${NODE}", "/gone/tokengraph/bundle/bin.js", "hook-sync"]\n`,
        [NODE]: '',
        [BIN]: '',
      }),
    );
    expect(health.cursorHook).toEqual({ installed: true, missing: [oldNode] });
    expect(health.codexNotify).toEqual({ installed: true, detail: 'notify', missing: ['/gone/tokengraph/bundle/bin.js'] });
  });

  it('is unknown, not failing, for unreadable files and unsupported platforms', async () => {
    const health = await inspectAutoSync(deps({ '/home/me/.claude/settings.json': '{nope' }, { platform: 'win32' }));
    expect(health.claudeHook.installed).toBeNull();
    expect(health.schedule.installed).toBeNull();
  });
});

describe('inspectAutoSync for the Codex hook', () => {
  const FOREIGN = 'notify = ["/Apps/Codex Computer Use.app/SkyComputerUseClient", "turn-ended"]\n';
  const hooks = (node: string) =>
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${node}" "${BIN}" hook-sync --min-interval 600`, timeout: 30 }] }] } });

  it('reports the Stop hook, whether Codex approved it, and its missing paths', async () => {
    const pending = await inspectAutoSync(deps({ '/home/me/.codex/config.toml': FOREIGN, '/home/me/.codex/hooks.json': hooks(NODE), [NODE]: '', [BIN]: '' }));
    expect(pending.codexNotify).toEqual({
      installed: true,
      detail: 'Stop hook in hooks.json, not trusted in Codex yet, so it does not run',
      next: 'tokengraph install-hook --agent codex  (shows the steps)',
      missing: [],
    });
    const approved = await inspectAutoSync(
      deps({
        '/home/me/.codex/config.toml': `${FOREIGN}[hooks.state.${JSON.stringify(`${join('/home/me/.codex', 'hooks.json')}:stop:0:0`)}]\ntrusted_hash = "sha256:1"\n`,
        '/home/me/.codex/hooks.json': hooks('/gone/node'),
        [BIN]: '',
      }),
    );
    expect(approved.codexNotify).toEqual({ installed: true, detail: 'Stop hook in hooks.json', missing: ['/gone/node'] });
  });

  it('explains why nothing can be installed when notify is taken and hooks are off', async () => {
    const health = await inspectAutoSync(deps({ '/home/me/.codex/config.toml': `${FOREIGN}[features]\nhooks = false\n` }));
    expect(health.codexNotify.installed).toBe(false);
    expect(health.codexNotify.detail).toMatch(/^cannot install: notify is taken and hooks are turned off/);
  });
});
