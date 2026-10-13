import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCursorAdapter } from '../src/adapters/cursor/index.js';

const NOW = new Date().toISOString();

function line(generationId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    receivedAt: NOW,
    generationId,
    model: 'composer-2.5',
    modelId: 'composer-2.5',
    fast: false,
    status: 'completed',
    cursorVersion: '3.14.7',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...extra,
  });
}

describe('createCursorAdapter', () => {
  const saved = process.env['TOKENGRAPH_HOME'];
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tg-cursor-adapter-'));
    process.env['TOKENGRAPH_HOME'] = home;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
  });

  it('is not detected before the hook has recorded anything', async () => {
    expect(await createCursorAdapter().detect()).toBe(false);
  });

  it('reads recorded turns, skipping damaged lines', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'cursor-events.jsonl'), [line('g1'), 'garbage', line('g2', { inputTokens: null }), line('g3')].join('\n'));
    const adapter = createCursorAdapter({ timeZone: 'UTC' });
    expect(adapter.name).toBe('cursor');
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]!.counts.outputTokens).toBe(20);
    expect(result.notes?.some((n) => n.includes('1 Cursor turn'))).toBe(true);
  });

  it('collects without a note when the events file is simply missing', async () => {
    const adapter = createCursorAdapter({ timeZone: 'UTC' });
    const result = await adapter.collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(0);
    expect(result.notes).toBeUndefined();
  });

  it('reports a note instead of silently dropping usage when the events path cannot be read', async () => {
    // A directory where the events file is expected: readLines fails with EISDIR, not ENOENT.
    await mkdir(join(home, 'cursor-events.jsonl'), { recursive: true });
    const adapter = createCursorAdapter({ timeZone: 'UTC' });
    const result = await adapter.collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(0);
    expect(result.notes?.some((n) => n.includes('could not read Cursor events'))).toBe(true);
    await rm(join(home, 'cursor-events.jsonl'), { recursive: true, force: true });
  });
});
