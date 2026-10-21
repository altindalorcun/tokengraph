import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cursorAccountPath, foldCursorAccounts, readAccountRows } from '../src/adapters/cursor/accounts.js';
import { accountKeyFor } from '../src/adapters/cursor/credentials.js';
import {
  ANNOUNCEMENT,
  EXPIRED_BACKOFF_MS,
  EXPIRED_LINE,
  FIRST_START_MS,
  fetchWindow,
  runCursorFetch,
  THROTTLE_MS,
  type CursorFetchDeps,
} from '../src/adapters/cursor/fetch.js';
import { readFetchState } from '../src/adapters/cursor/fetch-state.js';
import type { RootContext } from '../src/agent-roots.js';
import { readConfig, writeConfig } from '../src/config.js';
import { emptyLedger } from '../src/ledger.js';
import { csvRow, fakeJwt, startFakeCursor, writeStateDb, type FakeCursor } from './fake-cursor.js';

const USER = 'user_01FETCHTEST';
const TOKEN = fakeJwt({ sub: `auth0|${USER}`, exp: 4_102_444_800 });
const KEY = accountKeyFor(USER);
const DAY = 86_400_000;

describe('fetchWindow', () => {
  it('asks for everything the first time and for whole UTC days from two days before the covered day after that', () => {
    const now = Date.parse('2026-10-21T15:30:00.000Z');
    expect(fetchWindow(undefined, now)).toEqual({ startMs: FIRST_START_MS, endMs: Date.parse('2026-10-22T00:00:00.000Z') - 1 });
    expect(fetchWindow('2026-10-20T08:15:00.000Z', now)).toEqual({ startMs: Date.parse('2026-10-18T00:00:00.000Z'), endMs: Date.parse('2026-10-22T00:00:00.000Z') - 1 });
    expect(fetchWindow('2020-01-01T00:00:00.000Z', now).startMs).toBe(FIRST_START_MS);
  });
});

describe('runCursorFetch', () => {
  let root: string;
  let cursor: FakeCursor;
  let context: RootContext;
  let now: Date;
  const saved = process.env['TOKENGRAPH_HOME'];

  const deps = (extra: Partial<CursorFetchDeps> = {}): Partial<CursorFetchDeps> => ({
    context,
    client: { endpoint: cursor.endpoint, allowUrl: (url) => url.hostname === '127.0.0.1' },
    now: () => now,
    ...extra,
  });
  const run = (trigger: 'manual' | 'hook' | 'schedule' = 'manual', explicit = false, extra: Partial<CursorFetchDeps> = {}) =>
    runCursorFetch({ trigger, explicit, deps: deps(extra) });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-cursor-fetch-'));
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
    await mkdir(join(root, 'tg'), { recursive: true });
    context = { platform: 'linux', env: { XDG_CONFIG_HOME: join(root, 'config') }, home: root };
    writeStateDb(context, { 'cursorAuth/accessToken': TOKEN, 'cursorAuth/cachedEmail': 'private@example.com' });
    cursor = await startFakeCursor();
    now = new Date('2026-10-21T15:30:00.000Z');
    cursor.rows = [
      csvRow('2026-10-01T10:00:00.000Z', 'composer-2', { input: 100, output: 10 }),
      csvRow('2026-10-20T10:00:00.000Z', 'claude-4.5-sonnet', { input: 50, cacheRead: 500, output: 5 }),
    ];
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
    await cursor.close();
    await rm(root, { recursive: true, force: true });
  });

  it('the first manual run announces the feature once, switches it on and fetches the whole history', async () => {
    const first = await run();
    expect(first.status).toBe('fetched');
    expect(first.lines[0]).toBe(ANNOUNCEMENT);
    expect(first.lines.at(-1)).toContain('2 new usage rows');
    expect((await readConfig()).cursor).toEqual({ fetch: true });
    const url = cursor.requests[0]!.url;
    expect(Number(url.searchParams.get('startDate'))).toBe(FIRST_START_MS);
    expect(Number(url.searchParams.get('endDate'))).toBe(Date.parse('2026-10-22T00:00:00.000Z') - 1);
    expect(await readAccountRows(KEY)).toHaveLength(2);
    expect((await readFetchState()).coveredThrough).toEqual({ [KEY]: now.toISOString() });

    advance(2 * THROTTLE_MS);
    const second = await run();
    expect(second.lines.join('\n')).not.toContain('reads your Cursor usage');
  });

  it('keeps the token, cookie, user id and e-mail out of every file it writes and every line it prints', async () => {
    const report = await run();
    cursor.respond = (_request, res) => {
      res.writeHead(401);
      res.end();
    };
    advance(2 * THROTTLE_MS);
    const failed = await run();
    const names = await readdir(join(root, 'tg'));
    const everything = [...report.lines, ...failed.lines];
    for (const name of names) everything.push(await readFile(join(root, 'tg', name), 'utf8'));
    const text = everything.join('\n');
    for (const secret of [TOKEN, TOKEN.split('.')[1]!, USER, 'WorkosCursorSessionToken', 'private@example.com']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(names).toContain(`cursor-account-${KEY}.jsonl`);
  });

  it('a hook or schedule run never fetches before a person has been told, and never reads Cursor then', async () => {
    let read = 0;
    for (const trigger of ['hook', 'schedule'] as const) {
      const report = await run(trigger, false, {
        readSignIn: async () => {
          read += 1;
          return { kind: 'not-installed' };
        },
      });
      expect(report).toEqual({ status: 'not-announced', lines: [] });
    }
    expect(read).toBe(0);
    expect(cursor.requests).toHaveLength(0);
    await writeConfig({ ...(await readConfig()), cursor: { fetch: true } });
    expect((await run('hook')).status).toBe('fetched');
  });

  it('does nothing, silently, when fetching is off; an explicit fetch says so', async () => {
    await writeConfig({ ...(await readConfig()), cursor: { fetch: false } });
    expect(await run()).toEqual({ status: 'off', lines: [] });
    expect((await run('manual', true)).lines[0]).toContain('tokengraph cursor on');
    expect(cursor.requests).toHaveLength(0);
  });

  it('fetches at most once an hour, except when asked to', async () => {
    await run();
    advance(THROTTLE_MS - 1000);
    expect((await run('hook')).status).toBe('throttled');
    expect((await run('manual', true)).status).toBe('fetched');
    advance(THROTTLE_MS + 1000);
    expect((await run('schedule')).status).toBe('fetched');
    expect(cursor.requests).toHaveLength(3);
  });

  it('later fetches start two whole UTC days before the last covered day', async () => {
    await run();
    advance(5 * DAY);
    await run();
    const url = cursor.requests[1]!.url;
    expect(new Date(Number(url.searchParams.get('startDate'))).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('fetching an overlapping window again adds nothing twice, and equal rows within one response all count', async () => {
    const twin = csvRow('2026-10-20T11:00:00.000Z', 'composer-2', { input: 7 });
    cursor.rows.push(twin, twin);
    await run();
    expect(await readAccountRows(KEY)).toHaveLength(4);
    advance(DAY);
    const again = await run();
    expect(again.lines.at(-1)).toContain('0 new usage rows');
    expect(await readAccountRows(KEY)).toHaveLength(4);
    // A late row inside the overlap is picked up; the old ones stay single.
    cursor.rows.push(csvRow('2026-10-21T09:00:00.000Z', 'composer-2', { input: 9 }));
    advance(DAY);
    await run();
    expect(await readAccountRows(KEY)).toHaveLength(5);
  });

  it('401 and 403 print one line, back off for six hours and change nothing; even an explicit fetch waits', async () => {
    await run();
    const stored = await readFile(cursorAccountPath(KEY), 'utf8');
    cursor.respond = (_request, res) => {
      res.writeHead(403);
      res.end();
    };
    advance(2 * THROTTLE_MS);
    const expired = await run();
    expect(expired).toEqual({ status: 'expired', lines: [EXPIRED_LINE] });
    expect(EXPIRED_LINE).toContain('open Cursor once');
    const state = await readFetchState();
    expect(Date.parse(state.backoffUntil!)).toBe(now.getTime() + EXPIRED_BACKOFF_MS);
    expect(state.coveredThrough[KEY]).toBeDefined();
    expect(await readFile(cursorAccountPath(KEY), 'utf8')).toBe(stored);

    const before = cursor.requests.length;
    advance(THROTTLE_MS);
    expect((await run('manual', true)).status).toBe('backoff');
    expect((await run('hook')).lines).toEqual([]);
    expect(cursor.requests).toHaveLength(before);

    cursor.respond = null;
    advance(EXPIRED_BACKOFF_MS);
    expect((await run()).status).toBe('fetched');
    expect((await readFetchState()).backoffUntil).toBeUndefined();
  });

  it('429 honours Retry-After', async () => {
    await run();
    cursor.respond = (_request, res) => {
      res.writeHead(429, { 'retry-after': '1800' });
      res.end();
    };
    advance(2 * THROTTLE_MS);
    expect((await run()).status).toBe('rate-limited');
    expect(Date.parse((await readFetchState()).backoffUntil!)).toBe(now.getTime() + 1800_000);
    advance(1700_000);
    expect((await run('manual', true)).status).toBe('backoff');
  });

  it('a bot challenge is a failure that changes nothing and does not move coveredThrough', async () => {
    await run();
    const before = await readFetchState();
    const stored = await readFile(cursorAccountPath(KEY), 'utf8');
    cursor.respond = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>challenge</html>');
    };
    advance(2 * THROTTLE_MS);
    const report = await run();
    expect(report.status).toBe('failed');
    expect(report.lines.join('\n')).toContain('Your stored usage is unchanged');
    const after = await readFetchState();
    expect(after.coveredThrough).toEqual(before.coveredThrough);
    expect(await readFile(cursorAccountPath(KEY), 'utf8')).toBe(stored);
  });

  it('does not call cursor.com with a token that has already expired', async () => {
    writeStateDb(context, { 'cursorAuth/accessToken': fakeJwt({ sub: USER, exp: Math.floor(now.getTime() / 1000) - 60 }) });
    expect(await run()).toMatchObject({ status: 'expired', lines: [ANNOUNCEMENT, EXPIRED_LINE] });
    expect(cursor.requests).toHaveLength(0);
  });

  it('says nothing when Cursor is not installed or signed out, unless asked', async () => {
    const missing = { readSignIn: async () => ({ kind: 'not-installed' as const }) };
    expect(await run('manual', false, missing)).toEqual({ status: 'not-installed', lines: [] });
    expect((await run('manual', true, missing)).lines[0]).toContain('not installed');
    expect((await readConfig()).cursor).toBeUndefined();
    const noSqlite = { readSignIn: async () => ({ kind: 'no-sqlite' as const }) };
    await writeConfig({ ...(await readConfig()), cursor: { fetch: true } });
    expect((await run('manual', false, noSqlite)).lines[0]).toContain('Node 22.13');
    expect((await run('hook', false, noSqlite)).lines).toEqual([]);
  });

  it('the stored rows become ledger account days, with coveredThrough', async () => {
    await run();
    const ledger = await foldCursorAccounts(emptyLedger(), await readFetchState());
    const account = ledger.accounts?.cursor?.[KEY];
    expect(account?.coveredThrough).toBe(now.toISOString());
    expect(Object.keys(account?.days ?? {}).length).toBe(2);
    const sonnet = Object.values(account!.days).flatMap((models) => Object.entries(models)).find(([model]) => model === 'claude-sonnet-4-5');
    expect(sonnet?.[1].standard).toMatchObject({ inputTokens: 50, cacheReadTokens: 500, outputTokens: 5 });
    // A file whose fetch was never recorded is not an account yet.
    expect((await foldCursorAccounts(emptyLedger(), { coveredThrough: {} })).accounts).toBeUndefined();
  });
});
