import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReadme } from '../src/commands/readme.js';
import { SYNC_SKIPPED } from '../src/commands/sync.js';
import { readConfig, writeConfig } from '../src/config.js';
import { configPath } from '../src/paths.js';

describe('readme', () => {
  beforeEach(async () => {
    await rm(configPath(), { force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks to log in first', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runReadme({ compact: false, copy: async () => true })).toBe(1);
  });

  it('prints and copies the snippet', async () => {
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } }, gists: { graph: 'aaaaaaaaaaaaaaaaaaaa' } });
    const copy = vi.fn(async () => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runReadme({ compact: true, copy })).toBe(0);
    expect(copy.mock.calls[0]![0]).toContain('tokengraph-compact-dark.svg');
    expect(log.mock.calls.flat().join('\n')).toContain('github.com/octocat/octocat');
    log.mockRestore();
  });

  it('saves a colour choice', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } }, gists: { graph: 'aaaaaaaaaaaaaaaaaaaa' } });
    await runReadme({ compact: false, colors: 'single', copy: async () => true, republish: async () => 0 });
    expect((await readConfig()).graph).toEqual({ colors: 'single' });
  });

  it('says so, and still prints the snippet, when the republish was skipped because another sync holds the lock', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } }, gists: { graph: 'aaaaaaaaaaaaaaaaaaaa' } });
    const code = await runReadme({ compact: false, colors: 'single', copy: async () => true, republish: async () => SYNC_SKIPPED });
    const output = log.mock.calls.flat().join('\n');
    expect(code).toBe(0);
    expect(output).toContain('Another sync is running; your colour choice is saved and applies on the next sync.');
    expect(output).toContain('tokengraph-dark.svg');
    expect((await readConfig()).graph).toEqual({ colors: 'single' });
  });
});
