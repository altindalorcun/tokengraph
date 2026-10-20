import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_ROOTS } from '../src/adapters/claude-code/roots.js';
import { CLINE_ROOTS } from '../src/adapters/cline/roots.js';
import { CODEX_ROOTS } from '../src/adapters/codex/roots.js';
import { COPILOT_ROOTS } from '../src/adapters/copilot-cli/roots.js';
import { GEMINI_ROOTS } from '../src/adapters/gemini-cli/roots.js';
import { GOOSE_ROOTS } from '../src/adapters/goose/roots.js';
import { PI_ROOTS } from '../src/adapters/pi/roots.js';
import { QWEN_ROOTS } from '../src/adapters/qwen-code/roots.js';
import { KILO_ROOTS, OPENCODE_ROOTS, ROOT_SPECS } from '../src/agent-root-specs.js';
import { candidateRoots, planScan, type RootContext, type RootSpec } from '../src/agent-roots.js';

type Env = Record<string, string | undefined>;
const linux = (env: Env = {}): RootContext => ({ platform: 'linux', env, home: '/home/me' });
const darwin = (env: Env = {}): RootContext => ({ platform: 'darwin', env, home: '/Users/me' });
const windows = (env: Env = {}): RootContext => ({ platform: 'win32', env, home: 'C:\\Users\\me' });

/** Every target path of a spec, lexically (no file system), as `kind path`. */
const targets = (spec: RootSpec, ctx: RootContext, remembered: string[] = []): string[] =>
  candidateRoots(spec, ctx, remembered).flatMap(({ root }) => spec.targets(root, ctx).map((target) => target.path));
const envRoots = (spec: RootSpec, ctx: RootContext): string[] => spec.fromEnv(ctx);

describe('claude-code roots', () => {
  it('uses ~/.claude (projects and transcripts) on every OS', () => {
    expect(targets(CLAUDE_CODE_ROOTS, linux())).toContain('/home/me/.claude/projects');
    expect(targets(CLAUDE_CODE_ROOTS, linux())).toContain('/home/me/.claude/transcripts');
    expect(targets(CLAUDE_CODE_ROOTS, darwin())).toContain('/Users/me/.claude/projects');
    expect(targets(CLAUDE_CODE_ROOTS, windows())).toContain(win32.join('C:\\Users\\me', '.claude', 'projects'));
  });

  it('reads CLAUDE_CONFIG_DIR trimmed and with ~ expanded, and ignores a relative one', () => {
    expect(envRoots(CLAUDE_CODE_ROOTS, linux({ CLAUDE_CONFIG_DIR: '  ~/.claude-work ' }))).toEqual(['/home/me/.claude-work']);
    expect(envRoots(CLAUDE_CODE_ROOTS, windows({ CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' }))).toEqual(['D:\\profiles\\work']);
    expect(envRoots(CLAUDE_CODE_ROOTS, linux({ CLAUDE_CONFIG_DIR: 'work' }))).toEqual([]);
    expect(envRoots(CLAUDE_CODE_ROOTS, linux({ CLAUDE_CONFIG_DIR: '' }))).toEqual([]);
  });

  it('puts Claude Desktop app data where each OS keeps it', () => {
    expect(targets(CLAUDE_CODE_ROOTS, darwin())).toEqual(
      expect.arrayContaining([
        '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions',
        '/Users/me/Library/Application Support/Claude/claude-code-sessions',
      ]),
    );
    expect(targets(CLAUDE_CODE_ROOTS, linux())).toContain('/home/me/.config/Claude/local-agent-mode-sessions');
    expect(targets(CLAUDE_CODE_ROOTS, windows())).toContain(win32.join('C:\\Users\\me', 'AppData', 'Roaming', 'Claude', 'claude-code-sessions'));
  });

  it('follows XDG_CONFIG_HOME on Linux and APPDATA on Windows for Claude Desktop, but neither on macOS', () => {
    expect(targets(CLAUDE_CODE_ROOTS, linux({ XDG_CONFIG_HOME: '/xdg' }))).toContain('/xdg/Claude/claude-code-sessions');
    expect(targets(CLAUDE_CODE_ROOTS, windows({ APPDATA: 'D:\\Roaming' }))).toContain(win32.join('D:\\Roaming', 'Claude', 'local-agent-mode-sessions'));
    expect(targets(CLAUDE_CODE_ROOTS, darwin({ XDG_CONFIG_HOME: '/xdg', APPDATA: 'D:\\x' })).some((path) => path.includes('xdg') || path.includes('D:'))).toBe(false);
  });
});

describe('codex roots', () => {
  it('uses ~/.codex, or CODEX_HOME when it is a non-empty absolute path', () => {
    expect(targets(CODEX_ROOTS, linux())).toEqual(['/home/me/.codex/sessions', '/home/me/.codex/archived_sessions']);
    expect(envRoots(CODEX_ROOTS, linux({ CODEX_HOME: '/data/codex' }))).toEqual(['/data/codex']);
    expect(envRoots(CODEX_ROOTS, darwin({ CODEX_HOME: '~/codex-b' }))).toEqual(['/Users/me/codex-b']);
    expect(envRoots(CODEX_ROOTS, windows({ CODEX_HOME: 'D:\\codex' }))).toEqual(['D:\\codex']);
  });

  it('treats an empty or blank CODEX_HOME as unset', () => {
    for (const value of ['', '   ']) {
      expect(envRoots(CODEX_ROOTS, linux({ CODEX_HOME: value }))).toEqual([]);
      expect(candidateRoots(CODEX_ROOTS, linux({ CODEX_HOME: value }))).toEqual([{ root: '/home/me/.codex', origin: 'default' }]);
    }
  });
});

describe('gemini-cli roots', () => {
  it('reads <home>/.gemini/tmp and the sandbox cache <home>/.cache/.gemini/tmp', () => {
    expect(targets(GEMINI_ROOTS, darwin())).toEqual(['/Users/me/.gemini/tmp', '/Users/me/.cache/.gemini/tmp']);
    expect(targets(GEMINI_ROOTS, windows())[0]).toBe(win32.join('C:\\Users\\me', '.gemini', 'tmp'));
  });

  it('moves both with GEMINI_CLI_HOME, and still keeps the default home', () => {
    const ctx = darwin({ GEMINI_CLI_HOME: '/Volumes/work/gemini-home' });
    expect(targets(GEMINI_ROOTS, ctx)).toEqual([
      '/Users/me/.gemini/tmp',
      '/Users/me/.cache/.gemini/tmp',
      '/Volumes/work/gemini-home/.gemini/tmp',
      '/Volumes/work/gemini-home/.cache/.gemini/tmp',
    ]);
  });
});

describe('cline roots', () => {
  const hosts = (spec: RootSpec, ctx: RootContext): string[] => targets(spec, ctx).filter((path) => path.includes('globalStorage'));

  it('reads the SDK and classic folders under ~/.cline/data', () => {
    expect(targets(CLINE_ROOTS, linux())).toEqual(expect.arrayContaining(['/home/me/.cline/data/sessions', '/home/me/.cline/data/tasks']));
  });

  it('keeps each OS to its own editor data folder', () => {
    expect(hosts(CLINE_ROOTS, darwin())).toContain('/Users/me/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks');
    expect(hosts(CLINE_ROOTS, linux())).toContain('/home/me/.config/Cursor/User/globalStorage/saoudrizwan.claude-dev/tasks');
    expect(hosts(CLINE_ROOTS, windows())).toContain(win32.join('C:\\Users\\me', 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'));
    expect(hosts(CLINE_ROOTS, linux()).some((path) => path.includes('Library'))).toBe(false);
    expect(hosts(CLINE_ROOTS, darwin()).some((path) => path.includes('.config'))).toBe(false);
  });

  it('knows the editor variants and the remote servers', () => {
    const found = hosts(CLINE_ROOTS, linux());
    for (const host of ['Windsurf - Next', 'VSCodium - Insiders', 'Code - OSS', 'Positron', 'Trae', 'Kiro', 'Antigravity', 'Cursor', 'Code - Insiders']) {
      expect(found, host).toContain(`/home/me/.config/${host}/User/globalStorage/saoudrizwan.claude-dev/tasks`);
    }
    for (const server of ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server', '.vscodium-server']) {
      expect(found, server).toContain(`/home/me/${server}/data/User/globalStorage/saoudrizwan.claude-dev/tasks`);
    }
  });

  it('honours XDG_CONFIG_HOME on Linux (and only there)', () => {
    expect(hosts(CLINE_ROOTS, linux({ XDG_CONFIG_HOME: '/xdg' }))).toContain('/xdg/Code/User/globalStorage/saoudrizwan.claude-dev/tasks');
    expect(hosts(CLINE_ROOTS, darwin({ XDG_CONFIG_HOME: '/xdg' })).some((path) => path.startsWith('/xdg'))).toBe(false);
  });

  it('honours APPDATA on Windows and falls back to <home>\\AppData\\Roaming', () => {
    expect(hosts(CLINE_ROOTS, windows({ APPDATA: 'D:\\Roaming' }))).toContain(win32.join('D:\\Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'));
    expect(hosts(CLINE_ROOTS, windows())).toContain(win32.join('C:\\Users\\me', 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'));
  });

  it('resolves Cline home like the SDK: HOME, then USERPROFILE, then HOMEDRIVE+HOMEPATH', () => {
    const sessions = (ctx: RootContext): string[] => targets(CLINE_ROOTS, ctx).filter((path) => path.endsWith('sessions'));
    // Git Bash exports HOME even on Windows; the SDK writes under it while Node's homedir() is USERPROFILE.
    expect(sessions(windows({ HOME: 'D:\\gitbash\\me', USERPROFILE: 'C:\\Users\\me' }))).toEqual([
      win32.join('C:\\Users\\me', '.cline', 'data', 'sessions'),
      win32.join('D:\\gitbash\\me', '.cline', 'data', 'sessions'),
    ]);
    expect(sessions(windows({ HOME: '/d/gitbash/me' }))).toContain(win32.join('D:\\gitbash\\me', '.cline', 'data', 'sessions'));
    expect(sessions(windows({ USERPROFILE: 'E:\\profile' }))).toContain(win32.join('E:\\profile', '.cline', 'data', 'sessions'));
    expect(sessions(windows({ HOMEDRIVE: 'F:', HOMEPATH: '\\Users\\me' }))).toContain(win32.join('F:\\Users\\me', '.cline', 'data', 'sessions'));
    expect(sessions(windows({ HOME: '~' }))).toHaveLength(1);
  });

  it('trims CLINE_* values, ignores relative ones, and reads CLINE_DIR/data too (the standalone ignores CLINE_DATA_DIR)', () => {
    const ctx = linux({ CLINE_DIR: ' /opt/cline ', CLINE_DATA_DIR: '  /srv/data  ', CLINE_SESSION_DATA_DIR: ' /srv/sessions ' });
    const all = targets(CLINE_ROOTS, ctx);
    expect(all).toEqual(expect.arrayContaining(['/opt/cline/data/sessions', '/opt/cline/data/tasks', '/srv/data/sessions', '/srv/data/tasks', '/srv/sessions']));
    expect(targets(CLINE_ROOTS, linux({ CLINE_DIR: 'relative', CLINE_DATA_DIR: ' ', CLINE_SESSION_DATA_DIR: 'also/relative' })).some((path) => path.includes('relative'))).toBe(false);
  });
});

describe('copilot-cli roots', () => {
  it('uses ~/.copilot/session-store.db on every OS, or a trimmed COPILOT_HOME', () => {
    expect(targets(COPILOT_ROOTS, linux())).toEqual(['/home/me/.copilot/session-store.db']);
    expect(targets(COPILOT_ROOTS, windows())).toEqual([win32.join('C:\\Users\\me', '.copilot', 'session-store.db')]);
    expect(envRoots(COPILOT_ROOTS, darwin({ COPILOT_HOME: ' ~/copilot-b ' }))).toEqual(['/Users/me/copilot-b']);
    expect(envRoots(COPILOT_ROOTS, linux({ COPILOT_HOME: '   ' }))).toEqual([]);
  });
});

describe('pi roots', () => {
  it('uses ~/.pi/agent/sessions, plus PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR', () => {
    expect(targets(PI_ROOTS, linux())).toEqual(['/home/me/.pi/agent/sessions']);
    expect(targets(PI_ROOTS, linux({ PI_CODING_AGENT_DIR: '~/pi-work', PI_CODING_AGENT_SESSION_DIR: '/mnt/sessions' }))).toEqual([
      '/home/me/.pi/agent/sessions',
      '/home/me/pi-work/sessions',
      '/mnt/sessions',
    ]);
  });

  it('reads values the way pi does: ~\\ and Git Bash paths on Windows, file:// URLs everywhere', () => {
    expect(envRoots(PI_ROOTS, windows({ PI_CODING_AGENT_DIR: '~\\pi' }))).toEqual(['C:\\Users\\me\\pi']);
    expect(envRoots(PI_ROOTS, windows({ PI_CODING_AGENT_DIR: '/d/pi' }))).toEqual(['D:\\pi']);
    expect(envRoots(PI_ROOTS, linux({ PI_CODING_AGENT_DIR: 'file:///srv/pi' }))).toEqual(['/srv/pi']);
    expect(envRoots(PI_ROOTS, darwin({ PI_CODING_AGENT_DIR: 'relative/pi' }))).toEqual([]);
  });
});

describe('qwen-code roots', () => {
  it('reads projects and usage under ~/.qwen, QWEN_HOME and QWEN_RUNTIME_DIR', () => {
    expect(targets(QWEN_ROOTS, linux())).toEqual(['/home/me/.qwen/projects', '/home/me/.qwen/usage']);
    expect(targets(QWEN_ROOTS, darwin({ QWEN_HOME: '~/q', QWEN_RUNTIME_DIR: '/tmp/run' }))).toEqual([
      '/Users/me/.qwen/projects',
      '/Users/me/.qwen/usage',
      '/tmp/run/projects',
      '/tmp/run/usage',
      '/Users/me/q/projects',
      '/Users/me/q/usage',
    ]);
    expect(envRoots(QWEN_ROOTS, windows({ QWEN_HOME: '~\\q' }))).toEqual(['C:\\Users\\me\\q']);
    expect(envRoots(QWEN_ROOTS, linux({ QWEN_HOME: 'q' }))).toEqual([]);
  });
});

describe('goose roots', () => {
  const db = (...parts: string[]): string => [...parts, 'sessions', 'sessions.db'].join('/');

  it('lists the XDG data dir on Linux with the legacy folder after it', () => {
    expect(targets(GOOSE_ROOTS, linux())).toEqual([db('/home/me/.local/share/goose'), db('/home/me/.local/share/Block/goose')]);
  });

  it('lists the XDG data dir on macOS, not ~/Library, then the three legacy folders', () => {
    expect(targets(GOOSE_ROOTS, darwin())).toEqual([
      db('/Users/me/.local/share/goose'),
      db('/Users/me/Library/Application Support/goose'),
      db('/Users/me/Library/Application Support/Block/goose'),
      db('/Users/me/.local/share/Block/goose'),
    ]);
  });

  it('uses %APPDATA%\\Block\\goose\\data on Windows, falling back to <home>\\AppData\\Roaming', () => {
    expect(targets(GOOSE_ROOTS, windows())).toEqual([win32.join('C:\\Users\\me', 'AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions', 'sessions.db')]);
    expect(targets(GOOSE_ROOTS, windows({ APPDATA: 'D:\\Roaming' }))).toContain(win32.join('D:\\Roaming', 'Block', 'goose', 'data', 'sessions', 'sessions.db'));
  });

  it('adds an absolute GOOSE_PATH_ROOT/data and an absolute XDG_DATA_HOME, and ignores relative ones', () => {
    expect(envRoots(GOOSE_ROOTS, linux({ GOOSE_PATH_ROOT: '/srv/goose', XDG_DATA_HOME: '/xdg' }))).toEqual(['/srv/goose/data', '/xdg/goose']);
    expect(envRoots(GOOSE_ROOTS, linux({ GOOSE_PATH_ROOT: 'rel', XDG_DATA_HOME: 'rel' }))).toEqual([]);
    expect(envRoots(GOOSE_ROOTS, windows({ GOOSE_PATH_ROOT: 'D:\\goose' }))).toEqual([win32.join('D:\\goose', 'data')]);
  });
});

describe('opencode and kilo roots', () => {
  it('use ${XDG_DATA_HOME || ~/.local/share}/<product> on every OS, macOS and Windows included', () => {
    expect(targets(OPENCODE_ROOTS, darwin())).toEqual(['/Users/me/.local/share/opencode']);
    expect(targets(KILO_ROOTS, linux({ XDG_DATA_HOME: '/xdg' }))).toEqual(['/home/me/.local/share/kilo', '/xdg/kilo']);
    expect(targets(OPENCODE_ROOTS, windows())).toEqual([win32.join('C:\\Users\\me', '.local', 'share', 'opencode')]);
    expect(targets(OPENCODE_ROOTS, linux({ XDG_DATA_HOME: '' }))).toEqual(['/home/me/.local/share/opencode']);
  });

  it('name a database from OPENCODE_DB / KILO_DB: absolute as is, relative against the data folder, :memory: never', () => {
    expect(envRoots(KILO_ROOTS, linux({ KILO_DB: '/data/k.db' }))).toEqual(['/data/k.db']);
    expect(envRoots(KILO_ROOTS, linux({ KILO_DB: 'custom.db' }))).toEqual(['/home/me/.local/share/kilo/custom.db']);
    expect(envRoots(OPENCODE_ROOTS, linux({ OPENCODE_DB: 'x.db', XDG_DATA_HOME: '/xdg' }))).toEqual(['/xdg/opencode', '/xdg/opencode/x.db']);
    expect(envRoots(OPENCODE_ROOTS, linux({ OPENCODE_DB: ':memory:' }))).toEqual([]);
    expect(OPENCODE_ROOTS.targets('/data/k.db', linux())).toEqual([{ path: '/data/k.db', kind: 'db' }]);
    expect(OPENCODE_ROOTS.targets('/home/me/.local/share/opencode', linux())).toEqual([{ path: '/home/me/.local/share/opencode', kind: 'dir' }]);
  });
});

describe('every spec', () => {
  it('has a unique known source and resolves on all three platforms without throwing', async () => {
    expect(new Set(ROOT_SPECS.map((spec) => spec.source)).size).toBe(ROOT_SPECS.length);
    for (const ctx of [linux(), darwin(), windows()]) {
      for (const spec of ROOT_SPECS) {
        expect(targets(spec, ctx).length, `${spec.source} on ${ctx.platform}`).toBeGreaterThan(0);
        expect(await planScan(spec, { ...ctx, home: posix.join('/nonexistent-tokengraph-home', ctx.platform) })).toBeInstanceOf(Array);
      }
    }
  });
});
