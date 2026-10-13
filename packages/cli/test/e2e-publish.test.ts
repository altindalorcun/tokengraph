import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runLogin } from '../src/commands/login.js';
import { runReadme } from '../src/commands/readme.js';
import { runSync } from '../src/commands/sync.js';
import { readConfig, writeConfig } from '../src/config.js';
import { pollForToken } from '../src/github/device-flow.js';
import { startFakeGitHub } from './fake-github.js';
import { writeClaudeTranscript } from './fixtures-claude.js';

// Everything an adapter or the publisher reads from the environment points into a temp folder, so the test
// sees only its fixture transcripts and never the developer's real agents, ledger or config.
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
  'TOKENGRAPH_GITHUB_API',
  'TOKENGRAPH_GITHUB_WEB',
] as const;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let github: Awaited<ReturnType<typeof startFakeGitHub>>;
let root: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = await mkdtemp(join(tmpdir(), 'tokengraph-e2e-'));
  process.env['HOME'] = join(root, 'home');
  process.env['USERPROFILE'] = join(root, 'home');
  process.env['CODEX_HOME'] = join(root, 'codex');
  process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude');
  process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
  process.env['GEMINI_CLI_HOME'] = join(root, 'gemini');
  process.env['CLINE_DATA_DIR'] = join(root, 'cline-data');
  process.env['CLINE_SESSION_DATA_DIR'] = join(root, 'cline-sessions');
  process.env['XDG_DATA_HOME'] = join(root, 'xdg-data');
  github = await startFakeGitHub();
  process.env['TOKENGRAPH_GITHUB_API'] = github.url;
  process.env['TOKENGRAPH_GITHUB_WEB'] = github.url;
  await writeClaudeTranscript(join(root, 'claude'), [
    { id: 'msg_a1', timestamp: daysAgo(1), inputTokens: 1_000, outputTokens: 20_000 },
    { id: 'msg_a2', timestamp: daysAgo(3), inputTokens: 2_000, outputTokens: 40_000 },
  ]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await github.close();
  await rm(root, { recursive: true, force: true });
});

describe('login → sync → readme, end to end', () => {
  it('publishes a graph a README can show', async () => {
    const code = await runLogin(
      { method: 'device', openBrowser: false },
      {
        isTTY: false,
        copy: async () => false,
        pollForToken: (deviceCode) => {
          github.approve();
          return pollForToken(deviceCode, { sleep: async () => undefined });
        },
        firstPublish: () => runSync({ sinceDays: 400, theme: 'light', quiet: true }),
        offerSchedule: async () => undefined,
      },
    );
    expect(code).toBe(0);
    const config = await readConfig();
    const graph = github.gists.get(config.gists!.graph!)!;
    expect(graph.public).toBe(true);
    expect(graph.files['tokengraph-light.svg']).toMatch(/^<svg/);
    const response = await fetch(`${github.url}/raw/${graph.id}/tokengraph-dark.svg`);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    const data = github.gists.get(config.gists!.data!)!;
    expect(data.public).toBe(false);
    expect(Object.keys(data.files).some((name) => name.startsWith('machine-'))).toBe(true);
    expect(await runReadme({ compact: false, copy: async () => true })).toBe(0);
  });

  it('a deleted graph gist comes back on the next sync', async () => {
    const before = (await readConfig()).gists!.graph!;
    github.gists.delete(before);
    expect(await runSync({ sinceDays: 30, theme: 'light', quiet: true })).toBe(0);
    const after = (await readConfig()).gists!.graph!;
    expect(after).not.toBe(before);
    expect(github.gists.has(after)).toBe(true);
  });

  it('a second machine (fresh home, new fingerprint) adds up instead of replacing', async () => {
    const config = await readConfig();
    const graphId = config.gists!.graph!;
    const dataId = config.gists!.data!;
    const svgBefore = github.gists.get(graphId)!.files['tokengraph-light.svg'];
    const machineFiles = () => Object.keys(github.gists.get(dataId)!.files).filter((name) => /^machine-.*\.json$/.test(name));
    expect(machineFiles()).toHaveLength(1);

    const firstHome = process.env['TOKENGRAPH_HOME'];
    const firstClaude = process.env['CLAUDE_CONFIG_DIR'];
    const secondHome = await mkdtemp(join(root, 'second-tg-'));
    const secondClaude = join(root, 'second-claude');
    try {
      process.env['TOKENGRAPH_HOME'] = secondHome;
      process.env['CLAUDE_CONFIG_DIR'] = secondClaude;
      // The same GitHub login and token, but nothing else: this machine has never published.
      await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 'gho_fake' } } });
      // Usage on a day the first machine has none of, so the combined graph gains a cell.
      await writeClaudeTranscript(secondClaude, [{ id: 'msg_b1', timestamp: daysAgo(6), inputTokens: 5_000, outputTokens: 90_000 }]);

      expect(await runSync({ sinceDays: 400, theme: 'light', quiet: true, deps: { fingerprint: async () => 'fp-second' } })).toBe(0);

      const secondConfig = await readConfig();
      expect(secondConfig.gists).toEqual({ graph: graphId, data: dataId });
      expect(secondConfig.machineId).toBeDefined();
      expect(machineFiles()).toHaveLength(2);
      expect(await readdir(secondHome)).toContain('state.json');
      const svgAfter = github.gists.get(graphId)!.files['tokengraph-light.svg'];
      expect(svgAfter).toMatch(/^<svg/);
      expect(svgAfter).not.toBe(svgBefore);
    } finally {
      process.env['TOKENGRAPH_HOME'] = firstHome;
      process.env['CLAUDE_CONFIG_DIR'] = firstClaude;
    }
  });
});
