import { describe, expect, it } from 'vitest';
import { crontabOutput, detectAutoSync, hasTokenGraphNotify } from '../../src/tui/auto-sync.js';

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
    expect(status).toEqual({ claudeHook: true, cursorHook: false, codexNotify: false, schedule: true });
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
    expect(status).toEqual({ claudeHook: null, cursorHook: false, codexNotify: false, schedule: true });
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

describe('hasTokenGraphNotify', () => {
  it('only counts a top-level notify that runs hook-sync', () => {
    expect(hasTokenGraphNotify('notify = ["node", "/x/token-graph/dist/bin.js", "hook-sync", "--min-interval", "600"]\n')).toBe(true);
    expect(hasTokenGraphNotify('notify = [\n  "node",\n  "/x/token-graph/dist/bin.js",\n  "hook-sync",\n]\n')).toBe(true);
    expect(hasTokenGraphNotify('[profile]\nnotify = ["node", "/x/token-graph/dist/bin.js", "hook-sync"]\n')).toBe(false);
    expect(hasTokenGraphNotify('notify = ["other-tool"]\n')).toBe(false);
  });
});
