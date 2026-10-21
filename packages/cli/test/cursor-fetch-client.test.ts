import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchCursorUsageCsv, isCursorUrl } from '../src/adapters/cursor/fetch-client.js';
import { csvRow, startFakeCursor, type FakeCursor } from './fake-cursor.js';

const TOKEN = 'header.payload.signature';
const REQUEST = { token: TOKEN, userId: 'user_01ABC', startMs: 1_000, endMs: 2_000_000_000_000 };

describe('isCursorUrl', () => {
  it('allows only https cursor.com and www.cursor.com', () => {
    expect(isCursorUrl(new URL('https://cursor.com/a'))).toBe(true);
    expect(isCursorUrl(new URL('https://www.cursor.com/a'))).toBe(true);
    for (const bad of ['http://cursor.com/a', 'https://evil.com/a', 'https://cursor.com.evil.com/a', 'https://api.cursor.com/a', 'https://cursor.com:8443/a', 'https://evilcursor.com/']) {
      expect(isCursorUrl(new URL(bad)), bad).toBe(false);
    }
  });
});

describe('fetchCursorUsageCsv', () => {
  let cursor: FakeCursor;
  let elsewhere: FakeCursor;
  const allowUrl = (url: URL) => url.hostname === '127.0.0.1';
  const client = (extra: object = {}) => ({ endpoint: cursor.endpoint, allowUrl, ...extra });

  beforeEach(async () => {
    cursor = await startFakeCursor();
    elsewhere = await startFakeCursor();
  });
  afterEach(async () => {
    await cursor.close();
    await elsewhere.close();
  });

  it('sends the cookie, referer, origin, a browser user agent and the window, and parses the CSV', async () => {
    cursor.rows = [csvRow('2026-10-01T10:00:00.000Z', 'composer-2', { input: 5, output: 2 })];
    const outcome = await fetchCursorUsageCsv(REQUEST, client());
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.parsed.rows).toHaveLength(1);
    const seen = cursor.requests[0]!;
    expect(seen.url.pathname).toBe('/api/dashboard/export-usage-events-csv');
    expect(seen.url.searchParams.get('strategy')).toBe('tokens');
    expect(seen.url.searchParams.get('startDate')).toBe('1000');
    expect(seen.url.searchParams.get('endDate')).toBe('2000000000000');
    expect(seen.headers['cookie']).toBe(`WorkosCursorSessionToken=user_01ABC%3A%3A${TOKEN}`);
    expect(seen.headers['referer']).toBe('https://www.cursor.com/settings');
    expect(seen.headers['origin']).toBe('https://cursor.com');
    expect(seen.headers['user-agent']).toMatch(/^Mozilla\/5\.0 .*Chrome/);
  });

  it('follows a redirect to an allowed address and keeps the cookie there', async () => {
    cursor.respond = (request, res) => {
      if (request.url.pathname === '/moved') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end('Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens\n');
      } else {
        res.writeHead(308, { location: `/moved?${request.url.searchParams}` });
        res.end();
      }
    };
    const outcome = await fetchCursorUsageCsv(REQUEST, client());
    expect(outcome.kind).toBe('ok');
    expect(cursor.requests.map((r) => r.url.pathname)).toEqual(['/api/dashboard/export-usage-events-csv', '/moved']);
    expect(cursor.requests[1]!.headers['cookie']).toContain(TOKEN);
  });

  it('refuses a redirect to another host and never sends the cookie there', async () => {
    cursor.respond = (_request, res) => {
      res.writeHead(302, { location: `http://localhost:${new URL(elsewhere.origin).port}/steal` });
      res.end();
    };
    const outcome = await fetchCursorUsageCsv(REQUEST, client());
    expect(outcome).toEqual({ kind: 'failed', reason: 'redirected away from cursor.com; nothing was sent there' });
    expect(elsewhere.requests).toHaveLength(0);
  });

  it('gives up on a redirect loop', async () => {
    cursor.respond = (_request, res) => {
      res.writeHead(302, { location: '/again' });
      res.end();
    };
    expect((await fetchCursorUsageCsv(REQUEST, client())).kind).toBe('failed');
    expect(cursor.requests.length).toBeLessThanOrEqual(5);
  });

  it.each([401, 403])('%i means the sign-in has expired', async (status) => {
    cursor.respond = (_request, res) => {
      res.writeHead(status);
      res.end('nope');
    };
    expect(await fetchCursorUsageCsv(REQUEST, client())).toEqual({ kind: 'expired' });
  });

  it('429 carries Retry-After in seconds or as a date, or nothing', async () => {
    cursor.respond = (_request, res) => {
      res.writeHead(429, { 'retry-after': '120' });
      res.end();
    };
    expect(await fetchCursorUsageCsv(REQUEST, client())).toEqual({ kind: 'rate-limited', retryAfterSeconds: 120 });
    cursor.respond = (_request, res) => {
      res.writeHead(429);
      res.end();
    };
    expect(await fetchCursorUsageCsv(REQUEST, client())).toEqual({ kind: 'rate-limited', retryAfterSeconds: null });
    cursor.respond = (_request, res) => {
      res.writeHead(429, { 'retry-after': new Date(Date.now() + 90_000).toUTCString() });
      res.end();
    };
    const dated = await fetchCursorUsageCsv(REQUEST, client());
    expect(dated.kind === 'rate-limited' && dated.retryAfterSeconds !== null && dated.retryAfterSeconds > 60 && dated.retryAfterSeconds <= 90).toBe(true);
  });

  it('a 200 that is not a CSV (a bot challenge page) is a failure', async () => {
    cursor.respond = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><title>Vercel Security Checkpoint</title>secret-looking-body</html>');
    };
    const outcome = await fetchCursorUsageCsv(REQUEST, client());
    expect(outcome.kind).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain('Vercel');
    expect(JSON.stringify(outcome)).not.toContain('secret-looking-body');
  });

  it('an empty CSV answer is an empty window, an empty HTML answer is not', async () => {
    cursor.respond = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
      res.end('');
    };
    expect(await fetchCursorUsageCsv(REQUEST, client())).toMatchObject({ kind: 'ok', parsed: { rows: [] } });
    cursor.respond = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('');
    };
    expect((await fetchCursorUsageCsv(REQUEST, client())).kind).toBe('failed');
  });

  it('drops a response larger than the cap, announced or streamed', async () => {
    cursor.respond = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end('x'.repeat(5000));
    };
    expect(await fetchCursorUsageCsv(REQUEST, client({ maxBytes: 1000 }))).toEqual({ kind: 'failed', reason: 'the response was larger than the limit and was dropped' });
    cursor.respond = (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' }); // chunked: no content-length
      res.write('y'.repeat(600));
      setTimeout(() => res.end('y'.repeat(600)), 20);
    };
    expect(await fetchCursorUsageCsv(REQUEST, client({ maxBytes: 1000 }))).toEqual({ kind: 'failed', reason: 'the response was larger than the limit and was dropped' });
  });

  it('times out, and other statuses and network errors fail with fixed texts', async () => {
    cursor.respond = () => {};
    expect(await fetchCursorUsageCsv(REQUEST, client({ timeoutMs: 80 }))).toEqual({ kind: 'failed', reason: 'cursor.com did not answer in time' });
    cursor.respond = (_request, res) => {
      res.writeHead(503);
      res.end('internal detail');
    };
    expect(await fetchCursorUsageCsv(REQUEST, client())).toEqual({ kind: 'failed', reason: 'cursor.com answered with status 503' });
    const unreachable = await fetchCursorUsageCsv(REQUEST, client({ fetch: () => Promise.reject(new Error(`boom ${TOKEN}`)) }));
    expect(unreachable).toEqual({ kind: 'failed', reason: 'could not reach cursor.com' });
  });

  it('refuses an endpoint that is not an allowed address before sending anything', async () => {
    const outcome = await fetchCursorUsageCsv(REQUEST, { endpoint: cursor.endpoint });
    expect(outcome.kind).toBe('failed');
    expect(cursor.requests).toHaveLength(0);
  });
});
