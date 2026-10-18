import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, CollectResult } from '@tokengraph/core';
import { collectLocal, noAgentsMessage, searchedPaths } from '../src/collect-local.js';
import { emptyLedger, ledgerToUsage } from '../src/ledger.js';

const counts = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };

function fake(name: string, source: CollectResult['source'] | null, detected = true): Adapter {
  return {
    name,
    detect: async () => detected,
    collect: async () => {
      if (!source) throw new Error('disk on fire');
      return { source, requestCount: 1, usage: [{ date: '2026-10-01', model: 'gpt-5', pricingTier: 'standard', counts }] };
    },
  };
}

describe('collectLocal', () => {
  it('merges detected adapters, records failures and reports progress in order', async () => {
    const events: string[] = [];
    const result = await collectLocal(emptyLedger(), new Date('2026-09-01'), {
      adapters: [fake('codex', 'codex-cli'), fake('broken', null), fake('absent', 'cline', false)],
      onProgress: (p) => events.push(`${p.adapter}:${p.state}`),
    });
    expect(result.detected).toEqual(['codex', 'broken']);
    expect(result.results.map((r) => r.source)).toEqual(['codex-cli']);
    expect(result.failures).toEqual([{ adapter: 'broken', message: 'disk on fire' }]);
    expect(ledgerToUsage(result.ledger, 'codex-cli')).toHaveLength(1);
    expect(events).toEqual(['codex:scanning', 'codex:done', 'broken:scanning', 'broken:failed']);
  });

  it('never shrinks what the input ledger already holds', async () => {
    const first = await collectLocal(emptyLedger(), new Date('2026-09-01'), { adapters: [fake('codex', 'codex-cli')] });
    const second = await collectLocal(first.ledger, new Date('2026-09-01'), { adapters: [] });
    expect(ledgerToUsage(second.ledger, 'codex-cli')).toHaveLength(1);
  });
});

describe('collectLocal default adapters', () => {
  const saved = process.env['CLAUDE_CONFIG_DIR'];
  let dir: string | undefined;
  afterEach(async () => {
    if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = saved;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('counts Claude Code subagent turns, like plain sync', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-collect-'));
    await mkdir(join(dir, 'projects', 'p'), { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      isSidechain: true,
      requestId: 'req_1',
      uuid: 'u1',
      message: { id: 'msg_side', model: 'claude-sonnet-5', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    await writeFile(join(dir, 'projects', 'p', 's.jsonl'), `${line}\n`);
    process.env['CLAUDE_CONFIG_DIR'] = dir;
    const result = await collectLocal(emptyLedger(), new Date('2020-01-01'));
    expect(ledgerToUsage(result.ledger, 'claude-code')).toHaveLength(1);
  });
});

describe('noAgentsMessage', () => {
  it('lists every searched path, indented under the header', () => {
    const message = noAgentsMessage();
    const lines = message.split('\n');
    expect(lines[0]).toMatch(/^No agent usage found\./);
    expect(lines.slice(1)).toEqual(searchedPaths().map((line) => `  ${line}`));
    expect(searchedPaths()).toHaveLength(8);
  });
});
