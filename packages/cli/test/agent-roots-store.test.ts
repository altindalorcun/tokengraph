import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { createClineAdapter } from '../src/adapters/cline/index.js';
import { createCodexAdapter } from '../src/adapters/codex/index.js';
import { createGeminiCliAdapter } from '../src/adapters/gemini-cli/index.js';
import { createPiAdapter } from '../src/adapters/pi/index.js';
import { agentRootsReport, rememberAgentRoots, rememberRootsForCommand } from '../src/agent-roots-store.js';
import type { RootContext } from '../src/agent-roots.js';
import { runHookSync } from '../src/commands/hook-sync.js';
import { runStatus } from '../src/commands/status.js';
import { parseConfig, readConfig, writeConfig } from '../src/config.js';
import { configPath } from '../src/paths.js';
import { writeClaudeTranscript } from './fixtures-claude.js';

const NOW = new Date().toISOString();

// Every test starts without a config: the throwaway TOKENGRAPH_HOME is shared by the tests of one file.
beforeEach(async () => {
  await rm(configPath(), { recursive: true, force: true });
});
const SINCE = new Date(Date.now() - 86_400_000);

describe('config agentRoots', () => {
  it('is optional: a config without it parses as before', () => {
    expect(parseConfig({ machineId: '3f2a1c00-0000-4000-8000-000000000000' })).toEqual({ machineId: '3f2a1c00-0000-4000-8000-000000000000' });
  });

  it('keeps well-formed entries for known sources and drops the rest', () => {
    const config = parseConfig({
      agentRoots: { 'claude-code': ['/a', '/a', '  ', 7, '/b'], 'not-a-source': ['/x'], codex: 'nope', pi: [] },
    });
    expect(config.agentRoots).toEqual({ 'claude-code': ['/a', '/b'] });
  });

  it('survives a write and a read, next to the other settings', async () => {
    await writeConfig({ graph: { colors: 'single' }, agentRoots: { 'codex-cli': ['/c'] } });
    expect(await readConfig()).toEqual({ graph: { colors: 'single' }, agentRoots: { 'codex-cli': ['/c'] } });
  });
});

describe('rememberAgentRoots', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-remember-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (env: Record<string, string>): RootContext => ({ platform: process.platform, env, home: join(dir, 'home') });

  it('records an override that exists, once, and keeps the rest of the config', async () => {
    const profile = join(dir, 'profile');
    await mkdir(join(profile, 'projects'), { recursive: true });
    await writeConfig({ machineId: '3f2a1c00-0000-4000-8000-000000000000' });

    expect(rememberAgentRoots(ctx({ CLAUDE_CONFIG_DIR: profile }))).toEqual({ 'claude-code': [profile] });
    expect((await readConfig()).agentRoots).toEqual({ 'claude-code': [profile] });
    expect((await readConfig()).machineId).toBe('3f2a1c00-0000-4000-8000-000000000000');

    // A second run with the same environment changes nothing.
    expect(rememberAgentRoots(ctx({ CLAUDE_CONFIG_DIR: profile }))).toEqual({});
  });

  it('writes the config atomically with mode 0600', async () => {
    const profile = join(dir, 'profile');
    await mkdir(join(profile, 'sessions'), { recursive: true });
    rememberAgentRoots(ctx({ CODEX_HOME: profile }));
    if (process.platform !== 'win32') expect((await stat(configPath())).mode & 0o777).toBe(0o600);
    expect((await readdir(join(configPath(), '..'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not record a default, a missing folder, a relative value or an empty one', async () => {
    const home = join(dir, 'home');
    await mkdir(join(home, '.codex', 'sessions'), { recursive: true });
    expect(rememberAgentRoots(ctx({ CODEX_HOME: join(home, '.codex') }))).toEqual({});
    expect(rememberAgentRoots(ctx({ CODEX_HOME: join(dir, 'missing') }))).toEqual({});
    expect(rememberAgentRoots(ctx({ CODEX_HOME: 'relative' }))).toEqual({});
    expect(rememberAgentRoots(ctx({ CODEX_HOME: ' ' }))).toEqual({});
    expect(rememberAgentRoots(ctx({}))).toEqual({});
    expect((await readConfig()).agentRoots).toBeUndefined();
  });

  it('records one folder once however it is spelled', async () => {
    const real = join(dir, 'real');
    await mkdir(join(real, 'sessions'), { recursive: true });
    const link = join(dir, 'link');
    try {
      await symlink(real, link, 'dir');
    } catch {
      return; // Symlinks need a privilege on some Windows setups.
    }
    rememberAgentRoots(ctx({ CODEX_HOME: real }));
    expect(rememberAgentRoots(ctx({ CODEX_HOME: link }))).toEqual({});
    expect((await readConfig()).agentRoots).toEqual({ 'codex-cli': [real] });
  });

  it('records several agents in one go, including a kinded root', async () => {
    const pi = join(dir, 'pi-sessions');
    await mkdir(pi, { recursive: true });
    const xdg = join(dir, 'xdg');
    await mkdir(join(xdg, 'opencode'), { recursive: true });
    const added = rememberAgentRoots(ctx({ PI_CODING_AGENT_SESSION_DIR: pi, XDG_DATA_HOME: xdg }));
    expect(added['pi']).toEqual([`sessions:${pi}`]);
    expect(added['opencode']).toEqual([join(xdg, 'opencode')]);
  });

  it('is done by sync, view, status, schedule and install-hook, and not by export', async () => {
    const profile = join(dir, 'profile');
    await mkdir(join(profile, 'sessions'), { recursive: true });
    expect(rememberRootsForCommand('export', ctx({ CODEX_HOME: profile }))).toEqual({});
    for (const command of ['sync', 'view', 'status', 'schedule', 'install-hook']) {
      await rm(configPath(), { force: true });
      expect(rememberRootsForCommand(command, ctx({ CODEX_HOME: profile })), command).toEqual({ 'codex-cli': [profile] });
    }
  });

  it('never throws when the config cannot be written', async () => {
    const profile = join(dir, 'profile');
    await mkdir(join(profile, 'sessions'), { recursive: true });
    await mkdir(configPath(), { recursive: true }); // a directory where the file should go
    expect(() => rememberAgentRoots(ctx({ CODEX_HOME: profile }))).not.toThrow();
    await rm(configPath(), { recursive: true, force: true });
  });
});

describe('hook-sync', () => {
  const saved = process.env['CLAUDE_CONFIG_DIR'];
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-hook-roots-'));
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = saved;
    await rm(dir, { recursive: true, force: true });
  });

  it("remembers the agent's CLAUDE_CONFIG_DIR before spawning the sync", async () => {
    await mkdir(join(dir, 'projects'), { recursive: true });
    process.env['CLAUDE_CONFIG_DIR'] = dir;
    const spawn = vi.fn(() => ({ unref: () => {} }));
    expect(runHookSync({ spawn, binPath: () => '/x/bin.js' })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((await readConfig()).agentRoots).toEqual({ 'claude-code': [dir] });
  });

  it('still spawns when remembering fails, and skips remembering when throttled', () => {
    const spawn = vi.fn(() => ({ unref: () => {} }));
    const rememberRoots = vi.fn(() => {
      throw new Error('boom');
    });
    expect(runHookSync({ spawn, binPath: () => '/x/bin.js', rememberRoots })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);

    const now = new Date('2026-10-03T12:00:00Z');
    expect(runHookSync({ spawn, rememberRoots, now: () => now, readStamp: () => now.getTime() - 1000 }, { minIntervalSeconds: 600 })).toBe(0);
    expect(rememberRoots).toHaveBeenCalledTimes(1);
  });
});

describe('a run without the environment (the hourly schedule)', () => {
  let dir: string;
  let home: string;
  let profile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-schedule-'));
    home = join(dir, 'home');
    profile = join(dir, 'profile');
    await mkdir(home, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const interactive: () => RootContext = () => ({ platform: process.platform, env: { CLAUDE_CONFIG_DIR: profile }, home });
  const scheduled: () => RootContext = () => ({ platform: process.platform, env: {}, home });

  it("still reads the profile an interactive run saw, and adds it to the default folder's usage", async () => {
    await writeClaudeTranscript(join(home, '.claude'), [{ id: 'msg_default', timestamp: NOW, inputTokens: 100, outputTokens: 1 }]);
    await writeClaudeTranscript(profile, [{ id: 'msg_profile', timestamp: NOW, inputTokens: 1000, outputTokens: 1 }]);

    // Without the memory the schedule sees only the default folder (and would max-merge the profile away).
    const before = await createClaudeCodeAdapter({ roots: { ctx: scheduled(), remembered: [] } }).collect(SINCE);
    expect(before.usage[0]?.counts.inputTokens).toBe(100);

    rememberAgentRoots(interactive());
    // The default path: the adapter reads the remembered roots from the config itself.
    const config = await readConfig();
    expect(config.agentRoots).toEqual({ 'claude-code': [profile] });
    const after = await createClaudeCodeAdapter({ roots: { ctx: scheduled(), remembered: config.agentRoots?.['claude-code'] ?? [] } }).collect(SINCE);
    expect(after.requestCount).toBe(2);
    expect(after.usage[0]?.counts.inputTokens).toBe(1100);
  });

  it('counts the same session once when the interactive run and the schedule both see the profile', async () => {
    await writeClaudeTranscript(profile, [{ id: 'msg_profile', timestamp: NOW, inputTokens: 1000, outputTokens: 1 }]);
    const both = { ctx: interactive(), remembered: [profile] };
    const result = await createClaudeCodeAdapter({ roots: both }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts.inputTokens).toBe(1000);
  });

  it('skips a remembered folder that was deleted, without a note or an error', async () => {
    await writeClaudeTranscript(join(home, '.claude'), [{ id: 'msg_default', timestamp: NOW, inputTokens: 100, outputTokens: 1 }]);
    const result = await createClaudeCodeAdapter({ roots: { ctx: scheduled(), remembered: [profile] } }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.notes).toBeUndefined();
  });

  it('uses the process environment and the config when no roots are injected', async () => {
    const saved = process.env['CLAUDE_CONFIG_DIR'];
    await writeClaudeTranscript(profile, [{ id: 'msg_profile', timestamp: NOW, inputTokens: 1000, outputTokens: 1 }]);
    await writeConfig({ agentRoots: { 'claude-code': [profile] } });
    delete process.env['CLAUDE_CONFIG_DIR'];
    try {
      const adapter = createClaudeCodeAdapter();
      expect(await adapter.detect()).toBe(true);
      expect((await adapter.collect(SINCE)).requestCount).toBe(1);
    } finally {
      if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
    }
  });
});

describe('the same root reached twice is not counted twice', () => {
  let dir: string;
  let home: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-twice-'));
    home = join(dir, 'home');
    await mkdir(home, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = (env: Record<string, string> = {}): RootContext => ({ platform: process.platform, env, home });

  /** An older Codex rollout: no response ids, so only reading the file once keeps it from counting twice. */
  const oldRollout = [
    JSON.stringify({ timestamp: NOW, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6-luna' } }),
    JSON.stringify({
      timestamp: NOW,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 107 },
          total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 107 },
        },
      },
    }),
  ].join('\n');

  async function symlinkOrSkip(target: string, link: string): Promise<boolean> {
    try {
      await symlink(target, link, 'dir');
      return true;
    } catch {
      return false; // Symlinks need a privilege on some Windows setups.
    }
  }

  it('Codex: CODEX_HOME equal to ~/.codex, a trailing slash and a symlink read a legacy rollout once', async () => {
    const codex = join(home, '.codex');
    await mkdir(join(codex, 'sessions'), { recursive: true });
    await writeFile(join(codex, 'sessions', 'rollout.jsonl'), oldRollout);
    const link = join(dir, 'codex-link');
    if (!(await symlinkOrSkip(codex, link))) return;

    const adapter = createCodexAdapter({ timeZone: 'UTC', roots: { ctx: ctx({ CODEX_HOME: `${codex}/` }), remembered: [link, codex] } });
    const result = await adapter.collect(SINCE);
    expect(result.usage[0]?.counts.outputTokens).toBe(7);
    expect(result.requestCount).toBe(1);
  });

  it('Codex: two real homes with different rollouts add up', async () => {
    const other = join(dir, 'other');
    await mkdir(join(home, '.codex', 'sessions'), { recursive: true });
    await mkdir(join(other, 'sessions'), { recursive: true });
    await writeFile(join(home, '.codex', 'sessions', 'a.jsonl'), oldRollout);
    await writeFile(join(other, 'sessions', 'b.jsonl'), oldRollout.replace('"output_tokens":7', '"output_tokens":50'));
    const result = await createCodexAdapter({ timeZone: 'UTC', roots: { ctx: ctx(), remembered: [other] } }).collect(SINCE);
    expect(result.usage[0]?.counts.outputTokens).toBe(57);
  });

  it('Gemini: GEMINI_CLI_HOME equal to the real home reads each chat once, and the sandbox cache follows it', async () => {
    const message = { id: 'g1', timestamp: NOW, type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 } };
    const chats = join(home, '.gemini', 'tmp', 'proj', 'chats');
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, 'session-1.jsonl'), JSON.stringify(message));
    const sandbox = join(dir, 'gh');
    const cache = join(sandbox, '.cache', '.gemini', 'tmp', 'proj', 'chats');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'session-2.jsonl'), JSON.stringify({ ...message, id: 'g2' }));

    const same = await createGeminiCliAdapter({ timeZone: 'UTC', roots: { ctx: ctx({ GEMINI_CLI_HOME: home }), remembered: [] } }).collect(SINCE);
    expect(same.requestCount).toBe(1);
    const both = await createGeminiCliAdapter({ timeZone: 'UTC', roots: { ctx: ctx({ GEMINI_CLI_HOME: sandbox }), remembered: [] } }).collect(SINCE);
    expect(both.requestCount).toBe(2);
  });

  it('pi: the session dir named by the environment and the same dir as the default are read once', async () => {
    const sessions = join(home, '.pi', 'agent', 'sessions', '--proj--');
    await mkdir(sessions, { recursive: true });
    const record = { type: 'message', timestamp: NOW, message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5', responseId: 'resp_1', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, timestamp: Date.now() } };
    await writeFile(join(sessions, 's.jsonl'), JSON.stringify(record));
    const adapter = createPiAdapter({ timeZone: 'UTC', roots: { ctx: ctx({ PI_CODING_AGENT_SESSION_DIR: join(home, '.pi', 'agent', 'sessions') }), remembered: [] } });
    expect(await adapter.detect()).toBe(true);
    const planned = await adapter.collect(SINCE);
    expect(planned.requestCount).toBe(1);
  });

  it('Cline: a data dir named by CLINE_DATA_DIR that is also ~/.cline/data is read once', async () => {
    const sessionsDir = join(home, '.cline', 'data', 'sessions', 'sess-1');
    await mkdir(sessionsDir, { recursive: true });
    const message = { id: 'm1', role: 'assistant', ts: Date.now(), modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic' }, metrics: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, content: [] };
    await writeFile(join(sessionsDir, 'sess-1.messages.json'), JSON.stringify({ version: 1, messages: [message] }));
    const adapter = createClineAdapter({ timeZone: 'UTC', roots: { ctx: ctx({ CLINE_DATA_DIR: join(home, '.cline', 'data') }), remembered: [join(home, '.cline', 'data')] } });
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(SINCE);
    expect(result.requestCount).toBe(1);
  });
});

describe('status agent folders', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-status-roots-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const ctx = (env: Record<string, string> = {}): RootContext => ({ platform: process.platform, env, home: join(dir, 'home') });

  it('lists scanned folders with their origin, and a remembered one that is gone as missing', async () => {
    const live = join(dir, 'live');
    await mkdir(join(live, 'sessions'), { recursive: true });
    const report = await agentRootsReport({ 'codex-cli': [live, join(dir, 'gone')] }, ctx({ CODEX_HOME: live }));
    const codex = report.find((entry) => entry.source === 'codex-cli')!;
    expect(codex.targets).toEqual([
      expect.objectContaining({ path: join(dir, 'home', '.codex', 'sessions'), origin: 'default', exists: false }),
      expect.objectContaining({ path: join(dir, 'home', '.codex', 'archived_sessions'), origin: 'default', exists: false }),
      expect.objectContaining({ path: join(live, 'sessions'), root: live, origin: 'env', exists: true }),
      expect.objectContaining({ path: join(live, 'archived_sessions'), origin: 'env', exists: false }),
      expect.objectContaining({ path: join(dir, 'gone', 'sessions'), root: join(dir, 'gone'), origin: 'remembered', exists: false }),
      expect.objectContaining({ path: join(dir, 'gone', 'archived_sessions'), origin: 'remembered', exists: false }),
    ]);
    expect(report.map((entry) => entry.source)).toEqual(['claude-code', 'codex-cli', 'gemini-cli', 'cline', 'opencode', 'kilo', 'copilot-cli', 'pi', 'qwen-code', 'goose']);
  });

  it('prints the folders in text and in --json', async () => {
    const live = join(dir, 'live');
    await mkdir(join(live, 'projects'), { recursive: true });
    await writeConfig({ agentRoots: { 'claude-code': [live, join(dir, 'gone')] } });
    // pi has a single default target; once it exists nothing is hidden, and the line says how many were found.
    await mkdir(join(process.env['HOME']!, '.pi', 'agent', 'sessions'), { recursive: true });
    const none = { installed: null, missing: [] };
    const deps = {
      autoSync: async () => ({ claudeHook: none, cursorHook: none, codexNotify: none, schedule: none }),
      retention: async () => [],
      legacyData: () => [],
    };

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
    await runStatus(deps, {});
    const text = lines.join('\n');
    expect(text).toContain('agent folders');
    expect(text).toMatch(new RegExp(`found\\s+${live.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\\\/]projects\\s+\\(remembered\\)`));
    expect(text).toMatch(/missing\s+.*gone.*projects\s+\(remembered\)/);
    expect(text).toMatch(/default location/);
    expect(text).toMatch(/^ {2}pi:\s+1 found$/m);

    lines.length = 0;
    await runStatus(deps, { json: true });
    const json = JSON.parse(lines.join('\n')) as { agentRoots: { source: string; targets: { path: string; origin: string; exists: boolean }[] }[] };
    const claude = json.agentRoots.find((entry) => entry.source === 'claude-code')!;
    expect(claude.targets.some((target) => target.origin === 'remembered' && target.exists)).toBe(true);
    expect(claude.targets.some((target) => target.origin === 'remembered' && !target.exists)).toBe(true);
  });
});
