import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runLogin, type LoginDeps } from '../src/commands/login.js';
import { configPath } from '../src/paths.js';
import { readConfig } from '../src/config.js';
import type { GitHubClient } from '../src/github/http.js';

const code = { deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };

function userClient(login: string, scopes: string[] | null): GitHubClient {
  return { getUser: async () => ({ login, scopes }) } as unknown as GitHubClient;
}

// Every dependency is replaced, so a test never reaches the real GitHub, browser, clipboard or `gh`.
function deps(overrides: Partial<LoginDeps> = {}): Partial<LoginDeps> {
  return {
    isTTY: true,
    findGh: () => null,
    ghToken: async () => null,
    clientForToken: () => userClient('octocat', ['gist']),
    requestDeviceCode: async () => code,
    pollForToken: async () => ({ accessToken: 'gho_device', scopes: ['gist'] }),
    ask: async () => true,
    copy: async () => true,
    open: () => undefined,
    firstPublish: async () => 0,
    offerSchedule: async () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  await rm(configPath(), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('login', () => {
  it('device flow: stores the token and publishes', async () => {
    const firstPublish = vi.fn(async () => 0);
    expect(await runLogin({ method: 'auto', openBrowser: false }, deps({ firstPublish }))).toBe(0);
    expect((await readConfig()).github).toEqual({ login: 'octocat', auth: { kind: 'token', token: 'gho_device' } });
    expect(firstPublish).toHaveBeenCalledOnce();
  });

  it('offers gh and stores only its path', async () => {
    const result = await runLogin(
      { method: 'auto', openBrowser: false },
      deps({ findGh: () => '/opt/homebrew/bin/gh', ghToken: async () => 'gho_gh', clientForToken: () => userClient('octocat', ['repo', 'gist']) }),
    );
    expect(result).toBe(0);
    expect((await readConfig()).github).toEqual({ login: 'octocat', auth: { kind: 'gh', ghPath: '/opt/homebrew/bin/gh' } });
  });

  it('falls back to the device flow when gh lacks the gist scope', async () => {
    const requestDeviceCode = vi.fn(async () => code);
    await runLogin(
      { method: 'auto', openBrowser: false },
      deps({ findGh: () => '/bin/gh', ghToken: async () => 'gho_gh', clientForToken: (token) => userClient('octocat', token === 'gho_gh' ? ['repo'] : ['gist']), requestDeviceCode }),
    );
    expect(requestDeviceCode).toHaveBeenCalledOnce();
    expect((await readConfig()).github?.auth.kind).toBe('token');
  });

  it('--gh fails clearly when gh cannot be used', async () => {
    expect(await runLogin({ method: 'gh', openBrowser: false }, deps())).toBe(1);
  });

  it('copies the one-time code', async () => {
    const copy = vi.fn(async () => true);
    await runLogin({ method: 'device', openBrowser: false }, deps({ copy }));
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
  });

  it('keeps an existing machine id', async () => {
    const { writeConfig } = await import('../src/config.js');
    await writeConfig({ machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40' });
    await runLogin({ method: 'device', openBrowser: false }, deps());
    expect((await readConfig()).machineId).toBe('3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40');
  });

  describe('gist ids from an earlier login', () => {
    const GISTS = { graph: 'aaaaaaaaaaaaaaaaaaaa', data: 'bbbbbbbbbbbbbbbbbbbb' };
    const OLD = { login: 'octocat', auth: { kind: 'token' as const, token: 'old' } };

    it('are dropped when a different account logs in', async () => {
      const { writeConfig } = await import('../src/config.js');
      await writeConfig({ github: OLD, gists: GISTS, machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40' });
      await runLogin({ method: 'device', openBrowser: false }, deps({ clientForToken: () => userClient('hubot', ['gist']) }));
      const config = await readConfig();
      expect(config.github?.login).toBe('hubot');
      expect(config.gists).toBeUndefined();
      expect(config.machineId).toBe('3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40');
    });

    it('are kept when the same account logs in again (case does not matter)', async () => {
      const { writeConfig } = await import('../src/config.js');
      await writeConfig({ github: OLD, gists: GISTS });
      await runLogin({ method: 'device', openBrowser: false }, deps({ clientForToken: () => userClient('OctoCat', ['gist']) }));
      expect((await readConfig()).gists).toEqual(GISTS);
    });
  });
});
