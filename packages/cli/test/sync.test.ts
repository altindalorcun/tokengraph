import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeminiCliAdapter } from '../src/adapters/gemini-cli/index.js';
import { runSync } from '../src/commands/sync.js';
import { acquireSyncLock } from '../src/sync-lock.js';

vi.mock('../src/adapters/gemini-cli/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/gemini-cli/index.js')>();
  return { ...actual, createGeminiCliAdapter: vi.fn(actual.createGeminiCliAdapter) };
});

const OPTIONS = { sinceDays: 30, local: true, theme: 'light' as const };
const T = new Date().toISOString();

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'TOKENGRAPH_HOME',
  'GEMINI_CLI_HOME',
  'CLINE_DATA_DIR',
  'CLINE_SESSION_DATA_DIR',
  'XDG_DATA_HOME',
] as const;

describe('runSync across agents', () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sync-'));
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env['HOME'] = join(root, 'home');
    // os.homedir() reads USERPROFILE on Windows, not HOME — keep both pointed at the temp dir.
    process.env['USERPROFILE'] = join(root, 'home');
    process.env['CODEX_HOME'] = join(root, 'codex');
    process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude');
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
    process.env['GEMINI_CLI_HOME'] = join(root, 'gemini');
    process.env['CLINE_DATA_DIR'] = join(root, 'cline-data');
    process.env['CLINE_SESSION_DATA_DIR'] = join(root, 'cline-sessions');
    process.env['XDG_DATA_HOME'] = join(root, 'xdg-data');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function writeCodex() {
    await mkdir(join(root, 'codex', 'sessions'), { recursive: true });
    await writeFile(
      join(root, 'codex', 'sessions', 'rollout-a.jsonl'),
      [
        JSON.stringify({ timestamp: T, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6-luna' } }),
        JSON.stringify({
          timestamp: T,
          type: 'token_usage_record',
          payload: { response_id: 'r1', turn_id: 't1', usage: { input_tokens: 100, output_tokens: 7 } },
        }),
      ].join('\n'),
    );
  }

  async function writeCursor() {
    await mkdir(join(root, 'tg'), { recursive: true });
    await writeFile(
      join(root, 'tg', 'cursor-events.jsonl'),
      JSON.stringify({
        v: 1,
        receivedAt: T,
        generationId: 'gen-1',
        model: 'composer-2.5',
        modelId: 'composer-2.5',
        fast: true,
        status: 'completed',
        cursorVersion: '3.14.7',
        inputTokens: 100,
        outputTokens: 9,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }) + '\n',
    );
  }

  async function writeClaude() {
    await mkdir(join(root, 'claude', 'projects', 'p'), { recursive: true });
    await writeFile(
      join(root, 'claude', 'projects', 'p', 's.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: T,
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    );
  }

  async function ledger() {
    return JSON.parse(await readFile(join(root, 'tg', 'state.json'), 'utf8'));
  }

  it('fails only when no agent data exists at all, and reports the resolved paths it looked in', async () => {
    expect(await runSync(OPTIONS)).toBe(1);
    const [message] = vi.mocked(console.error).mock.calls[0]!;
    expect(message).toContain(join(root, 'claude', 'projects'));
    expect(message).toContain(join(root, 'codex', 'sessions'));
  });

  it('mentions the Cursor hook when no agent data exists', async () => {
    expect(await runSync(OPTIONS)).toBe(1);
    const message = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(message).toContain('install-hook --agent cursor');
  });

  it('mentions Gemini CLI, Cline and OpenCode when no agent data exists', async () => {
    expect(await runSync(OPTIONS)).toBe(1);
    const message = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(message).toContain('Gemini CLI');
    expect(message).toContain('Cline');
    expect(message).toContain('OpenCode');
  });

  it('syncs Cursor alone when no other agent is installed', async () => {
    await writeCursor();
    expect(await runSync(OPTIONS)).toBe(0);
    const saved = await ledger();
    expect(Object.keys(saved.sources)).toEqual(['cursor']);
    const [date] = Object.keys(saved.sources['cursor']);
    expect(saved.sources['cursor'][date]['composer-2.5-fast'].standard.outputTokens).toBe(9);
  });

  it('syncs Codex alone when Claude Code is not installed', async () => {
    await writeCodex();
    expect(await runSync(OPTIONS)).toBe(0);
    const saved = await ledger();
    expect(Object.keys(saved.sources)).toEqual(['codex-cli']);
  });

  it('records both agents under their own source', async () => {
    await writeCodex();
    await writeClaude();
    expect(await runSync(OPTIONS)).toBe(0);
    const saved = await ledger();
    expect(Object.keys(saved.sources).sort()).toEqual(['claude-code', 'codex-cli']);
    const [date] = Object.keys(saved.sources['codex-cli']);
    expect(saved.sources['codex-cli'][date]['gpt-6-luna'].standard.outputTokens).toBe(7);
  });

  it('saves locally and exits 0 when never logged in (hook run included)', async () => {
    await writeCodex();
    const code = await runSync({ ...OPTIONS, local: false, trigger: 'hook' });
    expect(code).toBe(0);
    expect(Object.keys((await ledger()).sources)).toContain('codex-cli');
  });

  it('continues past an adapter whose collect() throws, and still writes the ledger for the sources that succeeded', async () => {
    await writeClaude();
    vi.mocked(createGeminiCliAdapter).mockReturnValueOnce({
      name: 'gemini-cli',
      detect: async () => true,
      collect: async () => {
        throw new Error('disk read failed');
      },
    });

    expect(await runSync(OPTIONS)).toBe(0);

    const messages = vi.mocked(console.log).mock.calls.map((call) => call.join(' '));
    expect(messages.some((m) => m.includes('source: gemini-cli'))).toBe(true);
    expect(messages.some((m) => m.includes('note: could not be read (disk read failed)'))).toBe(true);

    const saved = await ledger();
    expect(Object.keys(saved.sources)).toEqual(['claude-code']);
  });

  it('skips with exit 0 and releases nothing when another sync holds the lock', async () => {
    const held = await acquireSyncLock();
    expect(held.acquired).toBe(true);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    expect(await runSync(OPTIONS)).toBe(0);
    expect(errors.join('\n')).toContain(`Another tokengraph sync is already running (pid ${process.pid}); skipping.`);
    expect((await acquireSyncLock()).acquired).toBe(false);
    if (held.acquired) await held.release();
  });

  it('releases the lock after a run', async () => {
    await runSync(OPTIONS);
    const lock = await acquireSyncLock();
    expect(lock.acquired).toBe(true);
    if (lock.acquired) await lock.release();
  });
});
