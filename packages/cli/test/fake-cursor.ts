import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cursorStateDbPath } from '../src/adapters/cursor/credentials.js';
import type { RootContext } from '../src/agent-roots.js';

/** A JWT-shaped string: the server of these tests never checks the signature, and neither does the CLI. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.c2ln`;
}

/** Writes a Cursor-shaped `state.vscdb` with the given rows at the path the context resolves to. */
export function writeStateDb(context: RootContext, rows: Record<string, string>): string {
  const path = cursorStateDbPath(context);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  } finally {
    db.close();
  }
  return path;
}

export const CSV_HEADER = 'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost';

/** One row of the v2 export: `cacheWrite` is the "w/ Cache Write" column. */
export function csvRow(at: string, model: string, counts: { input?: number; cacheWrite?: number; cacheRead?: number; output?: number } = {}): string {
  const { input = 100, cacheWrite = 0, cacheRead = 0, output = 10 } = counts;
  return `${at},Included,${model},No,${cacheWrite},${input},${cacheRead},${output},${cacheWrite + input + cacheRead + output},0.01`;
}

export interface SeenRequest {
  url: URL;
  headers: IncomingMessage['headers'];
}

export interface FakeCursor {
  /** `http://127.0.0.1:<port>`; the export lives under it at the real path. */
  origin: string;
  endpoint: string;
  requests: SeenRequest[];
  /** What to answer; replace to script a scenario. Default: the rows in `rows` inside the requested window, as a CSV. */
  respond: ((request: SeenRequest, res: ServerResponse) => void) | null;
  /** Rows (CSV lines) served by the default responder, filtered by the request's window. */
  rows: string[];
  close: () => Promise<void>;
}

function windowOf(url: URL): { start: number; end: number } {
  return { start: Number(url.searchParams.get('startDate')), end: Number(url.searchParams.get('endDate')) };
}

export async function startFakeCursor(): Promise<FakeCursor> {
  const fake: FakeCursor = { origin: '', endpoint: '', requests: [], respond: null, rows: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const request: SeenRequest = { url: new URL(req.url ?? '/', 'http://127.0.0.1'), headers: req.headers };
    fake.requests.push(request);
    if (fake.respond) return fake.respond(request, res);
    const { start, end } = windowOf(request.url);
    const body = fake.rows.filter((line) => {
      const at = Date.parse(line.split(',')[0]!);
      return at >= start && at <= end;
    });
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end([CSV_HEADER, ...body].join('\n') + '\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.origin = `http://127.0.0.1:${port}`;
  fake.endpoint = `${fake.origin}/api/dashboard/export-usage-events-csv`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}
