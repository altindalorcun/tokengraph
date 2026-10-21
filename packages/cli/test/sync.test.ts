import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeminiCliAdapter } from '../src/adapters/gemini-cli/index.js';
import { runSync, SYNC_SKIPPED } from '../src/commands/sync.js';
import { readConfig, writeConfig } from '../src/config.js';
import { GitHubError, GitHubNotFoundError, GitHubRateLimitError } from '../src/github/http.js';
import { readLedger } from '../src/ledger.js';
import { ledgerPath } from '../src/paths.js';
import { machineFileName } from '../src/publish/machines.js';
import { readLastPublish, readMachinesCache } from '../src/publish/machines-cache.js';
import type { Spinner } from '../src/spinner.js';
import { acquireSyncLock } from '../src/sync-lock.js';
import { fakeGitHubClient } from './fake-github-client.js';

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

  describe('publishing', () => {
    const LOGIN = { github: { login: 'octocat', auth: { kind: 'token' as const, token: 't' } } };
    const MACHINE = '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40';

    it('stays local when not logged in', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      expect(await runSync({ sinceDays: 30, theme: 'light', deps: { clientFor: () => client } })).toBe(0);
      expect(client.calls).toEqual([]);
    });

    it('publishes when logged in and saves machine id and gist ids', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      const code = await runSync({
        sinceDays: 30,
        theme: 'light',
        deps: { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => MACHINE },
      });
      expect(code).toBe(0);
      const config = await readConfig();
      expect(config.machineId).toBe(MACHINE);
      expect(config.gists?.graph).toBeDefined();
      expect(await readMachinesCache()).toEqual([]);
      expect(await readLastPublish()).not.toBeNull();
    });

    it('--local never touches GitHub', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      await runSync({ sinceDays: 30, theme: 'light', local: true, deps: { clientFor: () => client } });
      expect(client.calls).toEqual([]);
    });

    it('keeps the ledger and exits 1 when GitHub rate-limits', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      client.getGist = async () => {
        throw new GitHubRateLimitError('limited', 403, new Date('2026-10-13T12:00:00Z'));
      };
      client.listGists = client.getGist as never;
      await writeConfig(LOGIN);
      expect(await runSync({ sinceDays: 30, theme: 'light', deps: { clientFor: () => client, fingerprint: async () => 'fp' } })).toBe(1);
      expect(Object.keys((await readLedger(ledgerPath())).sources).length).toBeGreaterThan(0);
    });

    it('explains a gist that belongs to another account and keeps the usage', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      const deps = { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => MACHINE };
      expect(await runSync({ sinceDays: 30, theme: 'light', deps })).toBe(0);
      // `gh auth switch`: the cached gist ids are readable but the new account cannot write them.
      client.updateGist = async () => {
        throw new GitHubNotFoundError('Not Found', 404);
      };
      const later = new Date(Date.now() + 3 * 24 * 3600 * 1000);
      vi.mocked(console.error).mockClear();
      expect(await runSync({ sinceDays: 30, theme: 'light', deps: { ...deps, now: () => later } })).toBe(1);
      const output = vi.mocked(console.error).mock.calls.flat().join('\n');
      expect(output).toContain('belong to a different GitHub account');
      expect(output).toContain('tokengraph login');
      expect(output).toContain('saved locally');
      expect(output).not.toContain('Could not publish');
    });

    it('warns and still exits 0 when this machine\'s gist file cannot be read', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      const deps = { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => MACHINE };
      expect(await runSync({ sinceDays: 30, theme: 'light', deps })).toBe(0);
      // A newer tokengraph rewrote our file in a format this version cannot parse.
      const data = [...client.gists.values()].find((gist) => machineFileName(MACHINE) in gist.files)!;
      data.files[machineFileName(MACHINE)] = { filename: machineFileName(MACHINE), content: '{"version":99}' };
      vi.mocked(console.log).mockClear();
      expect(await runSync({ sinceDays: 30, theme: 'light', deps })).toBe(0);
      const output = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(output).toContain('could not be read');
      expect(output).toContain('npm install -g tokengraph');
      expect(data.files[machineFileName(MACHINE)]!.content).toBe('{"version":99}');
    });

    // Runs `change` once, in the middle of the publish (before the first write reaches GitHub).
    function changeConfigDuringPublish(client: ReturnType<typeof fakeGitHubClient>, change: () => Promise<void>) {
      const updateGist = client.updateGist.bind(client);
      let done = false;
      client.updateGist = async (id, files) => {
        if (!done) {
          done = true;
          await change();
        }
        return updateGist(id, files);
      };
    }

    it('does not undo a logout that happened while it was publishing', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      changeConfigDuringPublish(client, () => writeConfig({}));
      const deps = { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => MACHINE };
      expect(await runSync({ sinceDays: 30, theme: 'light', deps })).toBe(0);
      const config = await readConfig();
      expect(config.github).toBeUndefined();
      expect(config.gists).toBeUndefined();
    });

    it('does not write gist ids back when another account logged in meanwhile', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      changeConfigDuringPublish(client, () => writeConfig({ github: { login: 'hubot', auth: { kind: 'token', token: 'u' } } }));
      const deps = { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => MACHINE };
      expect(await runSync({ sinceDays: 30, theme: 'light', deps })).toBe(0);
      const config = await readConfig();
      expect(config.github?.login).toBe('hubot');
      expect(config.gists).toBeUndefined();
    });

    it('keeps a colour choice made while it was publishing', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      changeConfigDuringPublish(client, () => writeConfig({ ...LOGIN, graph: { colors: 'single' } }));
      const deps = { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => MACHINE };
      expect(await runSync({ sinceDays: 30, theme: 'light', deps })).toBe(0);
      const config = await readConfig();
      expect(config.graph).toEqual({ colors: 'single' });
      expect(config.gists?.graph).toBeDefined();
      expect(config.machineId).toBe(MACHINE);
    });

    it('keeps the machine id when the graph step fails, and reuses it next time', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      const updateGist = client.updateGist.bind(client);
      let failGraph = true;
      client.updateGist = async (id, files) => {
        if (failGraph && 'README.md' in files) throw new GitHubError('boom', 500);
        return updateGist(id, files);
      };
      expect(await runSync({ sinceDays: 30, theme: 'light', deps: { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => MACHINE } })).toBe(1);
      expect((await readConfig()).machineId).toBe(MACHINE);
      failGraph = false;
      const second = '99999999-2222-4333-8444-555555555555';
      expect(await runSync({ sinceDays: 30, theme: 'light', deps: { clientFor: () => client, fingerprint: async () => 'other', newMachineId: () => second } })).toBe(0);
      expect((await readConfig()).machineId).toBe(MACHINE);
    });

    it('reports a lock skip distinctly when asked, and still exits 0 otherwise', async () => {
      const held = await acquireSyncLock();
      expect(await runSync({ ...OPTIONS, detailedExit: true })).toBe(SYNC_SKIPPED);
      expect(await runSync(OPTIONS)).toBe(0);
      if (held.acquired) await held.release();
    });

    it('--quiet prints only the publish summary', async () => {
      await writeClaude();
      const client = fakeGitHubClient();
      await writeConfig(LOGIN);
      expect(await runSync({ sinceDays: 30, theme: 'light', quiet: true, deps: { clientFor: () => client, fingerprint: async () => 'fp' } })).toBe(0);
      const output = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(output).not.toContain('source:');
      expect(output).toContain('Graph published');
    });
  });

  describe('spinner', () => {
    const LOGIN = { github: { login: 'octocat', auth: { kind: 'token' as const, token: 't' } } };

    /** Spinner calls and printed lines, in the order they happened. */
    function recorder() {
      const events: string[] = [];
      const spinner: Spinner = {
        start: (text) => events.push(`start ${text}`),
        clear: () => events.push('clear'),
        stop: () => events.push('stop'),
      };
      vi.mocked(console.log).mockImplementation((line: string) => void events.push(`print ${line}`));
      vi.mocked(console.error).mockImplementation((line: string) => void events.push(`print ${line}`));
      return { events, spinner };
    }

    /** Lines printed while the spinner's line was on screen (it would have been drawn over). */
    function printedOverSpinner(events: string[]): string[] {
      let showing = false;
      const over: string[] = [];
      for (const event of events) {
        if (event.startsWith('start ')) showing = true;
        else if (event === 'clear' || event === 'stop') showing = false;
        else if (showing) over.push(event);
      }
      return over;
    }

    it('names each agent while reading it and never prints over the spinner', async () => {
      await writeClaude();
      await writeCodex();
      const { events, spinner } = recorder();
      expect(await runSync({ ...OPTIONS, spinner })).toBe(0);
      expect(events).toContain('start Reading Claude Code…');
      expect(events).toContain('start Reading Codex CLI…');
      expect(events.indexOf('start Reading Claude Code…')).toBeLessThan(events.findIndex((e) => e.startsWith('print ')));
      expect(printedOverSpinner(events)).toEqual([]);
      expect(events.at(-1)).toBe('stop');
    });

    it('shows the publish step and stops before the result', async () => {
      await writeClaude();
      await writeConfig(LOGIN);
      const client = fakeGitHubClient();
      const { events, spinner } = recorder();
      expect(await runSync({ sinceDays: 30, theme: 'light', spinner, deps: { clientFor: () => client, fingerprint: async () => 'fp' } })).toBe(0);
      const publishing = events.indexOf('start Publishing your graph to GitHub…');
      expect(publishing).toBeGreaterThan(-1);
      expect(publishing).toBeLessThan(events.findIndex((e) => e.includes('Graph published')));
      expect(printedOverSpinner(events)).toEqual([]);
    });

    it('stops before explaining a failed publish', async () => {
      await writeClaude();
      await writeConfig(LOGIN);
      const client = fakeGitHubClient();
      client.getGist = async () => {
        throw new GitHubRateLimitError('limited', 403, new Date('2026-10-13T12:00:00Z'));
      };
      client.listGists = client.getGist as never;
      const { events, spinner } = recorder();
      expect(await runSync({ sinceDays: 30, theme: 'light', spinner, deps: { clientFor: () => client, fingerprint: async () => 'fp' } })).toBe(1);
      expect(events.some((e) => e.includes('rate-limiting'))).toBe(true);
      expect(printedOverSpinner(events)).toEqual([]);
    });

    it('stops before the no-agents message', async () => {
      const { events, spinner } = recorder();
      expect(await runSync({ ...OPTIONS, spinner })).toBe(1);
      expect(events.some((e) => e.includes('No agent usage found'))).toBe(true);
      expect(printedOverSpinner(events)).toEqual([]);
    });
  });
});
