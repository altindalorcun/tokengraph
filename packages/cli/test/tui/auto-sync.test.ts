import { describe, expect, it } from 'vitest';
import { crontabOutput, detectAutoSync } from '../../src/tui/auto-sync.js';

const HOOK = '"/usr/bin/node" "/x/token-graph/dist/bin.js" hook-sync';

/** The code builds paths with the host's separator; the fixtures are written with '/', so compare on that. */
const posix = (p: string) => p.replace(/\\/g, '/');

function deps(files: Record<string, string>, extra: Partial<Parameters<typeof detectAutoSync>[0]> = {}) {
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

describe('detectAutoSync', () => {
  it('finds the Claude hook and the launchd schedule', async () => {
    const status = await detectAutoSync(deps({
      '/home/me/.claude/settings.json': JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: HOOK }] }] } }),
      '/home/me/Library/LaunchAgents/dev.tokengraph.sync.plist': '<plist/>',
    }));
    expect(status).toEqual({ claudeHook: true, cursorHook: false, codexNotify: false, geminiHook: false, schedule: true, codex: { via: null, approval: null, notifyTaken: false, blocked: null, commands: [] } });
  });

  it('reports unknown for unreadable settings and unsupported platforms', async () => {
    const status = await detectAutoSync(deps({ '/home/me/.claude/settings.json': '{nope' }, { platform: 'win32' }));
    expect(status.claudeHook).toBeNull();
    expect(status.schedule).toBeNull();
  });

  it('reads crontab on linux', async () => {
    const status = await detectAutoSync(deps({}, { platform: 'linux', crontab: async () => '0 * * * * node x sync # token-graph-sync\n' }));
    expect(status.schedule).toBe(true);
  });
});

describe('detectAutoSync edge cases', () => {
  it('treats an empty crontab as not installed', async () => {
    const status = await detectAutoSync(deps({}, { platform: 'linux', crontab: async () => '' }));
    expect(status.schedule).toBe(false);
  });

  it('isolates a failing check to its own field', async () => {
    const files: Record<string, string> = {
      '/home/me/Library/LaunchAgents/dev.tokengraph.sync.plist': '<plist/>',
    };
    const status = await detectAutoSync(deps(files, {
      readText: async (p: string) => {
        if (posix(p) === '/home/me/.claude/settings.json') throw new Error('EACCES');
        return files[p] ?? null;
      },
    }));
    expect(status).toEqual({ claudeHook: null, cursorHook: false, codexNotify: false, geminiHook: false, schedule: true, codex: { via: null, approval: null, notifyTaken: false, blocked: null, commands: [] } });
  });

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty', async () => {
    const status = await detectAutoSync(deps({
      '/home/me/.claude/settings.json': JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: HOOK }] }] } }),
    }, { env: { CLAUDE_CONFIG_DIR: '' } }));
    expect(status.claudeHook).toBe(true);
  });
});

describe('crontabOutput', () => {
  it('maps crontab -l results', () => {
    expect(crontabOutput(null, 'x\n', '')).toBe('x\n');
    expect(crontabOutput(new Error('exit 1'), '', 'no crontab for me')).toBe('');
    expect(crontabOutput(new Error('timeout'), '', '')).toBeNull();
  });
});

describe('detectAutoSync for Codex', () => {
  const NODE = '/usr/bin/node';
  const BIN = '/x/tokengraph/dist/bin.js';
  const OUR_NOTIFY = `notify = ["${NODE}", "${BIN}", "hook-sync", "--min-interval", "600"]\n`;
  const FOREIGN = 'notify = ["/Applications/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient", "turn-ended"]\n';
  const OUR_HOOK = `"${NODE}" "${BIN}" hook-sync --min-interval 600`;
  const hooksJson = (command = OUR_HOOK) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 30 }] }] } });
  const approval = '[hooks.state]\n\n[hooks.state."/home/me/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n';

  it('counts our notify as installed', async () => {
    const status = await detectAutoSync(deps({ '/home/me/.codex/config.toml': OUR_NOTIFY }));
    expect(status.codexNotify).toBe(true);
    expect(status.codex).toMatchObject({ via: 'notify', notifyTaken: false, blocked: null, commands: [[NODE, BIN, 'hook-sync', '--min-interval', '600']] });
  });

  it('counts our Stop hook as installed and reads whether Codex approved it', async () => {
    const pending = await detectAutoSync(deps({ '/home/me/.codex/config.toml': FOREIGN, '/home/me/.codex/hooks.json': hooksJson() }));
    expect(pending.codexNotify).toBe(true);
    expect(pending.codex).toMatchObject({ via: 'hook', approval: 'pending', notifyTaken: true, commands: [[NODE, BIN, 'hook-sync', '--min-interval', '600']] });
    const approved = await detectAutoSync(deps({ '/home/me/.codex/config.toml': FOREIGN + approval, '/home/me/.codex/hooks.json': hooksJson() }));
    expect(approved.codex).toMatchObject({ via: 'hook', approval: 'approved' });
  });

  it('uses CODEX_HOME for both files', async () => {
    const status = await detectAutoSync(deps({ '/c/config.toml': FOREIGN, '/c/hooks.json': hooksJson() }, { env: { CODEX_HOME: '/c' } }));
    expect(status.codex).toMatchObject({ via: 'hook', approval: 'pending' });
  });

  it('sees a taken notify, and calls Codex blocked only when hooks are also turned off', async () => {
    const taken = await detectAutoSync(deps({ '/home/me/.codex/config.toml': FOREIGN }));
    expect(taken.codexNotify).toBe(false);
    expect(taken.codex).toMatchObject({ via: null, notifyTaken: true, blocked: null });
    const off = await detectAutoSync(deps({ '/home/me/.codex/config.toml': `${FOREIGN}\n[features]\nhooks = false\n` }));
    expect(off.codex?.blocked).toMatch(/turned off/);
    const managed = await detectAutoSync(deps({ '/home/me/.codex/config.toml': FOREIGN, '/etc/codex/requirements.toml': 'allow_managed_hooks_only = true\n' }));
    expect(managed.codex?.blocked).toMatch(/administrator/);
    // Hooks off but notify free: our notify still works, so nothing is blocked.
    const free = await detectAutoSync(deps({ '/home/me/.codex/config.toml': '[features]\nhooks = false\n' }));
    expect(free.codex).toMatchObject({ via: null, notifyTaken: false, blocked: null });
  });

  it('ignores foreign hooks and is unknown for an unreadable hooks.json', async () => {
    const foreign = await detectAutoSync(deps({ '/home/me/.codex/hooks.json': hooksJson('python3 ~/stop.py') }));
    expect(foreign.codexNotify).toBe(false);
    const broken = await detectAutoSync(deps({ '/home/me/.codex/hooks.json': '{nope' }));
    expect(broken.codexNotify).toBeNull();
    expect(broken.codex).toBeNull();
    // Our notify is enough to know, whatever hooks.json holds.
    const ours = await detectAutoSync(deps({ '/home/me/.codex/config.toml': OUR_NOTIFY, '/home/me/.codex/hooks.json': '{nope' }));
    expect(ours.codexNotify).toBe(true);
  });
});
