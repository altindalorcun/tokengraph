import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cursorAccountPath } from '../src/adapters/cursor/accounts.js';
import { accountKeyFor } from '../src/adapters/cursor/credentials.js';
import { readFetchState } from '../src/adapters/cursor/fetch-state.js';
import type { CursorFetchDeps } from '../src/adapters/cursor/fetch.js';
import type { RootContext } from '../src/agent-roots.js';
import { parseCursorArgs, runCursor } from '../src/commands/cursor.js';
import { runStatus } from '../src/commands/status.js';
import { runSync } from '../src/commands/sync.js';
import { readConfig } from '../src/config.js';
import { allLedgerUsage, readLedger } from '../src/ledger.js';
import { ledgerPath } from '../src/paths.js';
import { csvRow, fakeJwt, startFakeCursor, writeStateDb, type FakeCursor } from './fake-cursor.js';

const USER = 'user_01SYNCTEST';
const KEY = accountKeyFor(USER);
const OPTIONS = { sinceDays: 30, theme: 'light' as const };

describe('sync, cursor and status with the Cursor fetch', () => {
  let root: string;
  let cursor: FakeCursor;
  let context: RootContext;
  let now: Date;
  let logged: string[];
  const saved: Record<string, string | undefined> = {};

  const deps = (): { cursor: Partial<CursorFetchDeps> } => ({
    cursor: { context, client: { endpoint: cursor.endpoint, allowUrl: (url) => url.hostname === '127.0.0.1' }, now: () => now },
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-cursor-sync-'));
    for (const key of ['HOME', 'USERPROFILE', 'TOKENGRAPH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const) saved[key] = process.env[key];
    process.env['HOME'] = process.env['USERPROFILE'] = join(root, 'home');
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
    process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude');
    process.env['CODEX_HOME'] = join(root, 'codex');
    await mkdir(join(root, 'tg'), { recursive: true });
    context = { platform: 'linux', env: { XDG_CONFIG_HOME: join(root, 'config') }, home: root };
    writeStateDb(context, { 'cursorAuth/accessToken': fakeJwt({ sub: `auth0|${USER}`, exp: 4_102_444_800 }) });
    cursor = await startFakeCursor();
    now = new Date();
    cursor.rows = [csvRow(new Date(now.getTime() - 3 * 86_400_000).toISOString(), 'composer-2', { input: 1000, output: 100 })];
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logged.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void logged.push(String(line)));
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    await cursor.close();
    await rm(root, { recursive: true, force: true });
  });

  it('sync fetches first, announces it once, and puts the account into the ledger the graph is drawn from', async () => {
    expect(await runSync({ ...OPTIONS, deps: deps() })).toBe(0);
    expect(logged.join('\n')).toContain('tokengraph cursor off');
    expect(cursor.requests).toHaveLength(1);
    const ledger = await readLedger(ledgerPath());
    expect(ledger.accounts?.cursor?.[KEY]?.coveredThrough).toBe(now.toISOString());
    expect(allLedgerUsage(ledger).map((row) => [row.source, row.model, row.counts.inputTokens])).toEqual([['cursor', 'composer-2', 1000]]);
    expect((await readConfig()).cursor).toEqual({ fetch: true });
  });

  it('sync --local never fetches, but still folds what an earlier fetch stored', async () => {
    await runSync({ ...OPTIONS, deps: deps() });
    await rm(ledgerPath());
    cursor.requests.length = 0;
    expect(await runSync({ ...OPTIONS, local: true, deps: deps() })).toBe(0);
    expect(cursor.requests).toHaveLength(0);
    expect((await readLedger(ledgerPath())).accounts?.cursor?.[KEY]).toBeDefined();
  });

  it('a hook-triggered sync before the announcement fetches nothing; after it, it does, within the hourly throttle', async () => {
    await writeFile(join(root, 'claude-marker'), '');
    await runSync({ ...OPTIONS, trigger: 'hook', deps: deps() });
    expect(cursor.requests).toHaveLength(0);
    await runSync({ ...OPTIONS, deps: deps() });
    expect(cursor.requests).toHaveLength(1);
    await runSync({ ...OPTIONS, trigger: 'hook', deps: deps() });
    expect(cursor.requests).toHaveLength(1);
  });

  it('a failing fetch does not fail the sync and leaves the ledger as it was', async () => {
    cursor.respond = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>challenge</html>');
    };
    // Something else to sync, so the run is not "no agents found".
    await mkdir(join(root, 'tg'), { recursive: true });
    await writeFile(
      join(root, 'tg', 'cursor-events.jsonl'),
      JSON.stringify({ v: 1, receivedAt: now.toISOString(), generationId: 'g1', model: 'composer-2', modelId: 'composer-2', fast: false, status: 'completed', cursorVersion: '3.14.7', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    );
    expect(await runSync({ ...OPTIONS, deps: deps() })).toBe(0);
    expect(logged.join('\n')).toContain('Cursor history was not fetched');
    const ledger = await readLedger(ledgerPath());
    expect(ledger.accounts).toBeUndefined();
    expect(allLedgerUsage(ledger)).toHaveLength(1);
  });

  it('`cursor off` stops the fetch and keeps what was fetched; `cursor on` brings it back; `cursor fetch` ignores the throttle', async () => {
    await runSync({ ...OPTIONS, deps: deps() });
    expect(await runCursor('off')).toBe(0);
    expect((await readConfig()).cursor).toEqual({ fetch: false });
    cursor.requests.length = 0;
    await runSync({ ...OPTIONS, deps: deps() });
    expect(cursor.requests).toHaveLength(0);
    expect((await readLedger(ledgerPath())).accounts?.cursor?.[KEY]).toBeDefined();
    expect(await runCursor('fetch', deps().cursor)).toBe(1);
    expect(await runCursor('on')).toBe(0);
    expect(await runCursor('fetch', deps().cursor)).toBe(0);
    expect(await runCursor('fetch', deps().cursor)).toBe(0); // within the hour
    expect(cursor.requests).toHaveLength(2);
  });

  it('parses the cursor command arguments', () => {
    expect(parseCursorArgs(['fetch'])).toBe('fetch');
    expect(parseCursorArgs(['off'])).toBe('off');
    expect(parseCursorArgs([])).toContain('Usage');
    expect(parseCursorArgs(['fetch', 'x'])).toContain('Usage');
    expect(parseCursorArgs(['delete'])).toContain('Usage');
  });

  it('status --json shows the fetch state and no secrets', async () => {
    await runSync({ ...OPTIONS, deps: deps() });
    cursor.respond = (_request, res) => {
      res.writeHead(401);
      res.end();
    };
    now = new Date(now.getTime() + 2 * 3_600_000);
    await runCursor('fetch', deps().cursor);
    logged.length = 0;
    const health = { installed: false, missing: [], detail: undefined };
    await runStatus(
      { autoSync: async () => ({ claudeHook: health, cursorHook: health, codexNotify: health, schedule: health }) as never, legacyData: () => [], retention: async () => [] },
      { json: true },
    );
    const report = JSON.parse(logged.join('\n')) as { cursorFetch: Record<string, unknown> };
    expect(report.cursorFetch).toMatchObject({ setting: 'on', lastError: 'sign-in expired', coveredThrough: expect.any(String), accounts: { [KEY]: expect.any(String) } });
    expect(typeof report.cursorFetch['backoffUntil']).toBe('string');
    expect(JSON.stringify(report)).not.toContain(USER);
    expect(JSON.stringify(report)).not.toContain('eyJ');
    expect((await readFetchState()).coveredThrough[KEY]).toBeDefined();
    expect((await readFile(cursorAccountPath(KEY), 'utf8')).length).toBeGreaterThan(0);
  });
});
