import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStatus } from '../src/commands/status.js';
import { writeConfig } from '../src/config.js';
import { emptyLedger, mergeUsage } from '../src/ledger.js';
import { configPath, machinesCachePath } from '../src/paths.js';
import { writeMachinesCache } from '../src/publish/machines-cache.js';

const HEALTH = { installed: false, missing: [], detail: undefined };

describe('status with a GitHub login', () => {
  let lines: string[];
  beforeEach(async () => {
    await rm(configPath(), { force: true });
    await rm(machinesCachePath(), { force: true });
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const deps = {
    autoSync: async () => ({ claudeHook: HEALTH, cursorHook: HEALTH, codexNotify: HEALTH, schedule: HEALTH }) as never,
    legacyData: () => [],
  };

  it('shows the gist links and the other machines', async () => {
    await writeConfig({
      github: { login: 'octocat', auth: { kind: 'token', token: 't' } },
      gists: { graph: 'aaaaaaaaaaaaaaaaaaaa', data: 'bbbbbbbbbbbbbbbbbbbb' },
    });
    const counts = { inputTokens: 5, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: null, cacheCreation1hTokens: null };
    const usage = ['2026-10-11', '2026-10-12'].map((date) => ({ date, model: 'claude-opus-5-5', pricingTier: 'standard' as const, counts }));
    await writeMachinesCache([
      {
        schema: 1,
        machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40',
        label: 'darwin-3f2a1c',
        fingerprint: 'fp',
        cliVersion: '1.0.0',
        updatedAt: '2026-10-12T08:00:00.000Z',
        sources: mergeUsage(emptyLedger(), 'claude-code', usage).sources,
      },
    ]);
    await runStatus(deps);
    expect(lines).toContain('graph:   https://gist.github.com/octocat/aaaaaaaaaaaaaaaaaaaa');
    expect(lines).toContain('data:    https://gist.github.com/octocat/bbbbbbbbbbbbbbbbbbbb (secret)');
    expect(lines).toContain('other machines (as of the last publish):');
    expect(lines.some((line) => line.includes('darwin-3f2a1c') && line.includes('updated 2026-10-12') && line.includes('2 days'))).toBe(true);
  });

  it('shows when it last published and this machine\'s own label', async () => {
    await writeConfig({
      machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40',
      github: { login: 'octocat', auth: { kind: 'token', token: 't' } },
      gists: { graph: 'aaaaaaaaaaaaaaaaaaaa', data: 'bbbbbbbbbbbbbbbbbbbb' },
    });
    await writeMachinesCache([], undefined, '2026-10-13T10:00:00.000Z');
    await runStatus(deps);
    expect(lines).toContain(`last publish: ${new Date('2026-10-13T10:00:00.000Z').toLocaleString()}`);
    expect(lines.some((line) => line.startsWith('machine:') && line.includes(`${process.platform}-3f2a1c`))).toBe(true);
  });

  it('omits them when there is nothing published', async () => {
    await runStatus(deps);
    expect(lines.some((line) => line.startsWith('graph:') || line.startsWith('data:') || line.startsWith('other machines'))).toBe(false);
  });
});
