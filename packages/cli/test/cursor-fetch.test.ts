import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cursorAccountPath, foldCursorAccounts, readAccountRows } from '../src/adapters/cursor/accounts.js';
import { accountKeyFor } from '../src/adapters/cursor/credentials.js';
import {
  ANNOUNCEMENT,
  EXPIRED_BACKOFF_MS,
  EXPIRED_LINE,
  FIRST_START_MS,
  fetchWindow,
  fetchWindows,
  MAX_WINDOW_DAYS,
  runCursorFetch,
  THROTTLE_MS,
  type CursorFetchDeps,
} from '../src/adapters/cursor/fetch.js';
import { parseFetchState, readFetchState } from '../src/adapters/cursor/fetch-state.js';
import type { RootContext } from '../src/agent-roots.js';
import { readConfig, writeConfig } from '../src/config.js';
import { combineMachineUsage } from '@tokengraph/core';
import { emptyLedger, mergeCursorAccount, parseLedgerAccounts } from '../src/ledger.js';
import { CSV_HEADER, csvRow, fakeJwt, startFakeCursor, writeStateDb, type FakeCursor } from './fake-cursor.js';

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

describe('fetchWindows', () => {
  const now = Date.parse('2026-10-21T15:30:00.000Z');

  it('splits the first fetch into consecutive UTC-day windows of at most 31 days that tile the whole span', () => {
    const windows = fetchWindows(undefined, now);
    const whole = fetchWindow(undefined, now);
    expect(windows.length).toBeGreaterThan(40);
    expect(windows[0]!.startMs).toBe(FIRST_START_MS);
    expect(windows.at(-1)!.endMs).toBe(whole.endMs);
    windows.forEach((window, index) => {
      expect(window.startMs % DAY).toBe(0);
      expect((window.endMs + 1) % DAY).toBe(0);
      expect(window.endMs - window.startMs + 1).toBeLessThanOrEqual(MAX_WINDOW_DAYS * DAY);
      if (index > 0) expect(window.startMs).toBe(windows[index - 1]!.endMs + 1);
    });
  });

  it('is one window when the span is 31 days or less, and two when it is a day more', () => {
    expect(fetchWindows('2026-10-20T08:15:00.000Z', now)).toEqual([fetchWindow('2026-10-20T08:15:00.000Z', now)]);
    // 2026-09-18 minus the two-day overlap is 2026-09-16: exactly 36 days to the end of 2026-10-21 -> two windows.
    const two = fetchWindows('2026-09-18T00:00:00.000Z', now);
    expect(two).toHaveLength(2);
    expect(two[0]!.endMs - two[0]!.startMs + 1).toBe(MAX_WINDOW_DAYS * DAY);
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
    vi.setSystemTime(now);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-cursor-fetch-'));
    process.env['TOKENGRAPH_HOME'] = join(root, 'tg');
    await mkdir(join(root, 'tg'), { recursive: true });
    context = { platform: 'linux', env: { XDG_CONFIG_HOME: join(root, 'config') }, home: root };
    writeStateDb(context, { 'cursorAuth/accessToken': TOKEN, 'cursorAuth/cachedEmail': 'private@example.com' });
    cursor = await startFakeCursor();
    now = new Date('2026-10-21T15:30:00.000Z');
    // The fetch clamps stored instants to the clock; the tests' clock is fixed (and the fake server's Date header follows it).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    cursor.rows = [
      csvRow('2026-10-01T10:00:00.000Z', 'composer-2', { input: 100, output: 10 }),
      csvRow('2026-10-20T10:00:00.000Z', 'claude-4.5-sonnet', { input: 50, cacheRead: 500, output: 5 }),
    ];
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
    vi.useRealTimers();
    await cursor.close();
    await rm(root, { recursive: true, force: true });
  });

  const firstRequests = () => fetchWindows(undefined, now.getTime()).length;

  it('the first manual run announces the feature once, switches it on and fetches the whole history in windows', async () => {
    const first = await run();
    expect(first.status).toBe('fetched');
    expect(first.lines[0]).toBe(ANNOUNCEMENT);
    expect(first.lines.at(-1)).toContain('2 new usage rows');
    expect((await readConfig()).cursor).toEqual({ fetch: true });
    expect(cursor.requests).toHaveLength(firstRequests());
    const asked = cursor.requests.map(({ url }) => [Number(url.searchParams.get('startDate')), Number(url.searchParams.get('endDate'))]);
    expect(asked[0]![0]).toBe(FIRST_START_MS);
    expect(asked.at(-1)![1]).toBe(Date.parse('2026-10-22T00:00:00.000Z') - 1);
    asked.forEach(([start, end], index) => {
      expect(end! - start! + 1).toBeLessThanOrEqual(MAX_WINDOW_DAYS * DAY);
      if (index > 0) expect(start).toBe(asked[index - 1]![1]! + 1);
    });
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
    // The first run fetched every window; the later ones only the last two days' window.
    expect(cursor.requests).toHaveLength(firstRequests() + 2);
  });

  it('later fetches start two whole UTC days before the last covered day', async () => {
    await run();
    advance(5 * DAY);
    await run();
    const url = cursor.requests[firstRequests()]!.url;
    expect(new Date(Number(url.searchParams.get('startDate'))).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('a failure part-way keeps the windows already stored, covers only up to the last complete one, and the next run resumes there', async () => {
    const total = firstRequests();
    const failAt = 10;
    cursor.respond = (request, res) => {
      if (cursor.requests.length === failAt) {
        res.writeHead(500);
        res.end();
        return;
      }
      const start = Number(request.url.searchParams.get('startDate'));
      const end = Number(request.url.searchParams.get('endDate'));
      const body = cursor.rows.filter((line) => Date.parse(line.split(',')[0]!) >= start && Date.parse(line.split(',')[0]!) <= end);
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end([CSV_HEADER, ...body].join('\n') + '\n');
    };
    // A row in the 3rd window (2023-04), stored before the failure; and the two default rows (2026), not yet reached.
    const early = csvRow('2023-04-10T10:00:00.000Z', 'composer-2', { input: 5 });
    cursor.rows.push(early);
    const report = await run();
    expect(report.status).toBe('failed');
    expect(cursor.requests).toHaveLength(failAt);
    expect(report.lines.join('\n')).toContain('stored so far');
    expect(await readAccountRows(KEY)).toHaveLength(1);
    const lastDone = fetchWindows(undefined, now.getTime())[failAt - 2]!;
    const state = await readFetchState();
    expect(state.coveredThrough[KEY]).toBe(new Date(lastDone.endMs).toISOString());
    expect(state.lastSuccessAt).toBeUndefined();

    // Next run (after the throttle) resumes two days before the covered day, not from 2023.
    cursor.respond = null;
    advance(2 * THROTTLE_MS);
    cursor.requests.length = 0;
    const resumed = await run();
    expect(resumed.status).toBe('fetched');
    const firstAsked = Number(cursor.requests[0]!.url.searchParams.get('startDate'));
    expect(firstAsked).toBe(Math.floor(lastDone.endMs / DAY) * DAY - 2 * DAY);
    expect(cursor.requests.length).toBeLessThan(total - failAt + 3);
    expect(await readAccountRows(KEY)).toHaveLength(3);
    expect((await readFetchState()).coveredThrough[KEY]).toBe(now.toISOString());
  });

  it('an account with no usage at all still counts as fetched, so the next run does not start over', async () => {
    cursor.rows = [];
    await run();
    advance(2 * THROTTLE_MS);
    cursor.requests.length = 0;
    await run();
    expect(cursor.requests).toHaveLength(1);
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

  it('clamps coveredThrough to the server Date header when it is earlier than the local clock', async () => {
    cursor.respond = (_request, res) => {
      res.setHeader('date', new Date(now.getTime() - 3 * 3_600_000).toUTCString());
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end('');
    };
    await run();
    expect((await readFetchState()).coveredThrough[KEY]).toBe('2026-10-21T12:30:00.999Z');
  });

  it('a covered instant from the future (2030) is clamped when parsed and does not stop fetching', async () => {
    const future = '2030-01-01T00:00:00.000Z';
    expect(parseFetchState({ coveredThrough: { [KEY]: future }, lastAttemptAt: future }).coveredThrough[KEY]).toBe(now.toISOString());
    expect(parseFetchState({ lastAttemptAt: future, coveredThrough: {} }).lastAttemptAt).toBe(now.toISOString());
    expect(fetchWindows(future, now.getTime())).toEqual(fetchWindows(now.toISOString(), now.getTime()));
    expect(fetchWindows(future, now.getTime()).length).toBeGreaterThan(0);
    // The ledger side: parsing an account (own state or another machine's file) and merging both clamp.
    const parsed = parseLedgerAccounts({ cursor: { [KEY]: { coveredThrough: future, days: {} } } });
    expect(parsed?.cursor?.[KEY]?.coveredThrough).toBe(now.toISOString());
    expect(mergeCursorAccount(emptyLedger(), KEY, future, []).accounts?.cursor?.[KEY]?.coveredThrough).toBe(now.toISOString());
    // And the hook rows before that 2030 day are no longer dropped: the account covers up to now only.
    const hook = { source: 'cursor' as const, date: '2026-10-25', model: 'composer-2', pricingTier: 'standard' as const, counts: { inputTokens: 5, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: null, cacheCreation1hTokens: null } };
    const ledger = mergeCursorAccount(emptyLedger(), KEY, future, []);
    const rows = combineMachineUsage([{ usage: [hook], accounts: Object.fromEntries(Object.entries(ledger.accounts!.cursor!).map(([k, a]) => [k, { coveredThrough: a.coveredThrough, usage: [] }])) }]);
    expect(rows).toHaveLength(1);
  });

  it('keys account days on UTC days whatever the machine time zone, and keeps hours local', async () => {
    cursor.rows = [csvRow('2026-10-20T20:00:00.000Z', 'composer-2', { input: 100, output: 10 })];
    await run();
    const ledger = await foldCursorAccounts(emptyLedger(), await readFetchState(), 'Pacific/Port_Moresby');
    const account = ledger.accounts?.cursor?.[KEY];
    expect(Object.keys(account?.days ?? {})).toEqual(['2026-10-20']);
    // 20:00 UTC is already the next morning at +10: the hour lands on the local day.
    expect(Object.keys(ledger.accountHours?.[KEY] ?? {})).toEqual(['2026-10-21']);
  });
});
