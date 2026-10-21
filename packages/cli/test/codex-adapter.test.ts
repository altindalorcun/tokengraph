import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { createCodexAdapter } from '../src/adapters/codex/index.js';

const T = new Date().toISOString();

function rolloutLines(responseId: string, output: number): string {
  return [
    JSON.stringify({ timestamp: T, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6-luna' } }),
    JSON.stringify({
      timestamp: T,
      type: 'token_usage_record',
      payload: {
        response_id: responseId,
        turn_id: 't1',
        usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output },
      },
    }),
  ].join('\n');
}

describe('createCodexAdapter', () => {
  let home: string;
  const previous = process.env['CODEX_HOME'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    process.env['CODEX_HOME'] = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
  });

  it('is not detected without sessions or archived_sessions', async () => {
    expect(await createCodexAdapter().detect()).toBe(false);
  });

  it('reads live and archived rollouts and nothing else under CODEX_HOME', async () => {
    await mkdir(join(home, 'sessions', '2026', '09', '22'), { recursive: true });
    await mkdir(join(home, 'archived_sessions'), { recursive: true });
    await writeFile(join(home, 'sessions', '2026', '09', '22', 'rollout-a.jsonl'), rolloutLines('r1', 10));
    await writeFile(join(home, 'archived_sessions', 'rollout-b.jsonl'), rolloutLines('r2', 20));
    // Same shape outside the session folders: must never be read.
    await writeFile(join(home, 'history.jsonl'), rolloutLines('r3', 1000));

    const adapter = createCodexAdapter({ timeZone: 'UTC' });
    expect(adapter.name).toBe('codex-cli');
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(2);
    expect(result.usage.map((u) => [u.model, u.counts.outputTokens])).toEqual([['gpt-6-luna', 30]]);
  });

  it('notes skipped and fallback events for the sync summary', async () => {
    await mkdir(join(home, 'sessions'), { recursive: true });
    const bad = JSON.stringify({ timestamp: T, type: 'token_usage_record', payload: { response_id: 'x', usage: {} } });
    await writeFile(join(home, 'sessions', 'rollout-bad.jsonl'), bad);
    const result = await createCodexAdapter().collect(new Date(Date.now() - 86_400_000));
    expect(result.notes?.some((note) => note.includes('1 usage record'))).toBe(true);
  });

  it('treats an empty CODEX_HOME as unset and reads ~/.codex', async () => {
    const real = join(homedir(), '.codex');
    await mkdir(join(real, 'sessions'), { recursive: true });
    await writeFile(join(real, 'sessions', 'rollout-home.jsonl'), rolloutLines('r_home', 11));
    for (const value of ['', '   ']) {
      process.env['CODEX_HOME'] = value;
      const adapter = createCodexAdapter({ timeZone: 'UTC' });
      expect(await adapter.detect()).toBe(true);
      const result = await adapter.collect(new Date(Date.now() - 86_400_000));
      expect(result.usage.map((u) => u.counts.outputTokens)).toEqual([11]);
    }
  });

  it('reads CODEX_HOME and the default home together', async () => {
    const real = join(homedir(), '.codex');
    await mkdir(join(real, 'sessions'), { recursive: true });
    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(join(real, 'sessions', 'rollout-home.jsonl'), rolloutLines('r_home', 11));
    await writeFile(join(home, 'sessions', 'rollout-profile.jsonl'), rolloutLines('r_profile', 22));
    const result = await createCodexAdapter({ timeZone: 'UTC' }).collect(new Date(Date.now() - 86_400_000));
    expect(result.usage.map((u) => u.counts.outputTokens)).toEqual([33]);
  });
});
