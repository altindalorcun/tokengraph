import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClineAdapter } from '../src/adapters/cline/index.js';
import { kindedRoot } from '../src/agent-roots.js';

const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_SESSION_DATA_DIR', 'APPDATA'] as const;

function apiReq(ts: number, usage: Record<string, number>, modelInfo?: Record<string, string>) {
  return {
    ts,
    type: 'say',
    say: 'api_req_started',
    text: JSON.stringify({ request: 'secret prompt', ...usage, cost: 0.01 }),
    ...(modelInfo ? { modelInfo } : {}),
  };
}

function sdkAssistantMessage(id: string, ts: number, metrics: Record<string, number>) {
  return {
    id,
    role: 'assistant',
    ts,
    modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
    metrics,
    content: [{ type: 'text', text: 'reply' }],
  };
}

describe('createClineAdapter', () => {
  let home: string;
  let dataDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = await mkdtemp(join(tmpdir(), 'cline-home-'));
    dataDir = await mkdtemp(join(tmpdir(), 'cline-data-'));
    process.env['HOME'] = home;
    // os.homedir() reads USERPROFILE on Windows, not HOME — keep both pointed at the temp dir.
    process.env['USERPROFILE'] = home;
    delete process.env['CLINE_DIR'];
    process.env['CLINE_DATA_DIR'] = dataDir;
    delete process.env['CLINE_SESSION_DATA_DIR'];
    delete process.env['APPDATA'];
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('is not detected with nothing present', async () => {
    expect(await createClineAdapter().detect()).toBe(false);
  });

  it('dedupes the same classic task copied under two hosts, and falls back to task_metadata.json for a row without modelInfo', async () => {
    const taskId = '1758900000000';
    // Each OS keeps editor user data in one place; two editors on this one hold copies of the same task.
    const editors =
      process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : process.platform === 'win32' ? join(home, 'AppData', 'Roaming') : join(home, '.config');
    const macTaskDir = join(editors, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', taskId);
    const linuxTaskDir = join(editors, 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', taskId);
    await mkdir(macTaskDir, { recursive: true });
    await mkdir(linuxTaskDir, { recursive: true });

    const ts = Date.now() - 3_600_000;
    const messages = JSON.stringify([apiReq(ts, { tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0 })]);
    const metadata = JSON.stringify({ model_usage: [{ ts: ts - 1000, model_provider_id: 'anthropic', model_id: 'claude-sonnet-4-5-20250929' }] });
    await writeFile(join(macTaskDir, 'ui_messages.json'), messages);
    await writeFile(join(macTaskDir, 'task_metadata.json'), metadata);
    // The same task, copied verbatim under a second host's data directory.
    await writeFile(join(linuxTaskDir, 'ui_messages.json'), messages);
    await writeFile(join(linuxTaskDir, 'task_metadata.json'), metadata);

    const adapter = createClineAdapter({ timeZone: 'UTC' });
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(1);
    const at = new Date(ts);
    expect(result.hours).toEqual([{ date: at.toISOString().slice(0, 10), hour: at.getUTCHours(), weighted: 120 }]);
    expect(result.usage).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-4-5-20250929', counts: expect.objectContaining({ inputTokens: 100, outputTokens: 20 }) }),
    ]);
  });

  it("reads an SDK session's main and subagent message files, ignores compaction files and never opens secrets.json", async () => {
    const sessionId = '1758881523000_a1b2c';
    const sessionDir = join(dataDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });

    const ts = Date.now() - 3_600_000;
    await writeFile(
      join(sessionDir, `${sessionId}.messages.json`),
      JSON.stringify({ messages: [sdkAssistantMessage('main-1', ts, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })] }),
    );
    await writeFile(
      join(sessionDir, 'agent_sub1.messages.json'),
      JSON.stringify({ messages: [sdkAssistantMessage('sub-1', ts, { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 })] }),
    );
    // Must never be counted: not a `.messages.json` file, and holds a suspiciously large usage to
    // make an accidental read obvious.
    await writeFile(
      join(sessionDir, `${sessionId}.compaction.json`),
      JSON.stringify({ messages: [sdkAssistantMessage('compacted', ts, { inputTokens: 999999, outputTokens: 999999, cacheReadTokens: 0, cacheWriteTokens: 0 })] }),
    );
    // Must never be opened at all — invalid JSON proves it, since opening it would either throw or
    // produce an "unreadable" note.
    await writeFile(join(sessionDir, 'secrets.json'), 'not valid json {');

    const adapter = createClineAdapter({ timeZone: 'UTC' });
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(new Date(Date.now() - 86_400_000));
    const at = new Date(ts);
    expect(result.hours).toEqual([{ date: at.toISOString().slice(0, 10), hour: at.getUTCHours(), weighted: 1650 }]);
    expect(result.requestCount).toBe(2);
    expect(result.usage).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-4-6', counts: expect.objectContaining({ inputTokens: 1500, outputTokens: 150 }) }),
    ]);
    expect(result.notes?.some((note) => note.includes('could not be read'))).toBeFalsy();
  });

  it('notes a truncated ui_messages.json while still counting other data', async () => {
    const brokenTaskDir = join(dataDir, 'tasks', 'broken-task');
    const goodTaskDir = join(dataDir, 'tasks', 'good-task');
    await mkdir(brokenTaskDir, { recursive: true });
    await mkdir(goodTaskDir, { recursive: true });
    await writeFile(join(brokenTaskDir, 'ui_messages.json'), '[{"ts":123,');

    const ts = Date.now() - 3_600_000;
    await writeFile(
      join(goodTaskDir, 'ui_messages.json'),
      JSON.stringify([apiReq(ts, { tokensIn: 50, tokensOut: 5, cacheWrites: 0, cacheReads: 0 }, { providerId: 'anthropic', modelId: 'claude-sonnet-4-5-20250929' })]),
    );

    const result = await createClineAdapter({ timeZone: 'UTC' }).collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 50, outputTokens: 5 } });
    expect(result.notes?.some((note) => note.includes('could not be read'))).toBe(true);
  });

  describe('extra editor and server locations', () => {
    const SINCE = new Date(Date.now() - 86_400_000);
    const taskIn = async (userData: string, taskId: string, tokensIn: number) => {
      const dir = join(userData, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', taskId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'ui_messages.json'), JSON.stringify([apiReq(Date.now() - 3_600_000, { tokensIn, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { modelId: 'claude-sonnet-4-5', providerId: 'anthropic' })]));
    };
    const collectFrom = (remembered: string[], env: Record<string, string> = {}) =>
      createClineAdapter({ timeZone: 'UTC', roots: { ctx: { platform: process.platform, env, home }, remembered } }).collect(SINCE);

    it('reads a remembered editor folder (Windsurf Next, Trae) and a remembered remote server', async () => {
      const editors = join(home, 'custom-editors');
      await taskIn(join(editors, 'Windsurf - Next'), '1758900000001', 100);
      await taskIn(join(editors, 'Trae'), '1758900000002', 200);
      const server = join(home, '.windsurf-server');
      await taskIn(join(server, 'data'), '1758900000003', 400);
      const result = await collectFrom([kindedRoot('editors', editors)]);
      expect(result.requestCount).toBe(3);
      expect(result.usage.reduce((sum, row) => sum + row.counts.inputTokens, 0)).toBe(700);
    });

    it('reads the remote server folders by default, and ~/.cline/data/tasks of the standalone build', async () => {
      await taskIn(join(home, '.vscodium-server', 'data'), '1758900000004', 10);
      const standalone = join(home, '.cline', 'data', 'tasks', '1758900000005');
      await mkdir(standalone, { recursive: true });
      await writeFile(join(standalone, 'ui_messages.json'), JSON.stringify([apiReq(Date.now() - 3_600_000, { tokensIn: 20, tokensOut: 1, cacheWrites: 0, cacheReads: 0 }, { modelId: 'claude-sonnet-4-5', providerId: 'anthropic' })]));
      const result = await collectFrom([]);
      expect(result.usage.reduce((sum, row) => sum + row.counts.inputTokens, 0)).toBe(30);
    });

    it('reads XDG_CONFIG_HOME on Linux only', async () => {
      const xdg = join(home, 'xdg-config');
      await taskIn(join(xdg, 'Code'), '1758900000006', 5);
      const result = await collectFrom([], { XDG_CONFIG_HOME: xdg });
      expect(result.requestCount).toBe(process.platform === 'linux' ? 1 : 0);
    });
  });
});
