import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copilotHome, createCopilotCliAdapter } from '../src/adapters/copilot-cli/index.js';
import { loadSqlite } from '../src/adapters/opencode/sqlite.js';

const SINCE = new Date(Date.parse('2026-01-01T00:00:00Z'));
const SECRET_CWD = '/Users/secretuser/very-secret-project';
const SECRET_SUMMARY = 'TOP_SECRET_SESSION_SUMMARY';

type Db = InstanceType<typeof DatabaseSyncCtor>;
let DatabaseSync: typeof DatabaseSyncCtor;

beforeAll(async () => {
  const ctor = await loadSqlite();
  if (!ctor) throw new Error('this test suite requires node:sqlite');
  DatabaseSync = ctor;
});

/** The column set tokscale's test DDL uses (the richest one seen upstream). */
const FULL_COLUMNS = `id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, model TEXT, copilot_usage_model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
  total_nano_aiu INTEGER, duration_ms INTEGER, created_at TEXT`;
/** TokenTracker's test DDL: no copilot_usage_model, plus token_details_json. */
const LEAN_COLUMNS = `id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, token_details_json TEXT, created_at TEXT`;

function createStore(path: string, options: { columns?: string; version?: number | null | 'text' } = {}): Db {
  const db = new DatabaseSync(path);
  const version = options.version === undefined ? 6 : options.version;
  if (version !== null) {
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    if (version === 'text') db.exec(`INSERT INTO schema_version (version) VALUES ('banana')`);
    else db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  }
  db.exec(`CREATE TABLE assistant_usage_events (${options.columns ?? FULL_COLUMNS})`);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, summary TEXT)`);
  db.prepare('INSERT INTO sessions (id, cwd, summary) VALUES (?, ?, ?)').run('sess-a', SECRET_CWD, SECRET_SUMMARY);
  return db;
}

interface Event {
  session?: string;
  model?: string | null;
  usageModel?: string | null;
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  reasoning?: number | null;
  createdAt?: string | number | null;
}

function insertEvent(db: Db, event: Event, id?: number): void {
  db.prepare(
    `INSERT INTO assistant_usage_events (${id === undefined ? '' : 'id, '}session_id, turn_index, model, copilot_usage_model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, duration_ms, created_at)
     VALUES (${id === undefined ? '' : '?, '}?, 0, ?, ?, ?, ?, ?, ?, ?, 5000, 100, ?)`,
  ).run(
    ...(id === undefined ? [] : [id]),
    event.session ?? 'sess-a',
    event.model === undefined ? 'claude-sonnet-4.5' : event.model,
    event.usageModel === undefined ? 'claude-sonnet-4.5' : event.usageModel,
    event.input === undefined ? 1200 : event.input,
    event.output === undefined ? 300 : event.output,
    event.cacheRead === undefined ? 800 : event.cacheRead,
    event.cacheWrite === undefined ? 100 : event.cacheWrite,
    event.reasoning === undefined ? 120 : event.reasoning,
    event.createdAt === undefined ? '2026-09-21 18:45:02' : event.createdAt,
  );
}

describe('copilotHome', () => {
  it('uses COPILOT_HOME when set, else ~/.copilot', () => {
    const previous = process.env['COPILOT_HOME'];
    try {
      process.env['COPILOT_HOME'] = '/somewhere/copilot';
      expect(copilotHome()).toBe('/somewhere/copilot');
      process.env['COPILOT_HOME'] = '   ';
      expect(copilotHome()).toMatch(/\.copilot$/);
      delete process.env['COPILOT_HOME'];
      expect(copilotHome()).toMatch(/\.copilot$/);
    } finally {
      if (previous === undefined) delete process.env['COPILOT_HOME'];
      else process.env['COPILOT_HOME'] = previous;
    }
  });
});

describe('createCopilotCliAdapter', () => {
  let home: string;
  let dbPath: string;
  const previousCopilotHome = process.env['COPILOT_HOME'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'copilot-home-'));
    await mkdir(home, { recursive: true });
    dbPath = join(home, 'session-store.db');
    process.env['COPILOT_HOME'] = home;
  });

  afterEach(async () => {
    if (previousCopilotHome === undefined) delete process.env['COPILOT_HOME'];
    else process.env['COPILOT_HOME'] = previousCopilotHome;
    await rm(home, { recursive: true, force: true });
  });

  const collect = (options: Parameters<typeof createCopilotCliAdapter>[0] = {}, since = SINCE) =>
    createCopilotCliAdapter({ timeZone: 'UTC', ...options }).collect(since);

  it('is named copilot-cli and is not detected without a session-store.db', async () => {
    const adapter = createCopilotCliAdapter();
    expect(adapter.name).toBe('copilot-cli');
    expect(await adapter.detect()).toBe(false);
    // A config-only ~/.copilot (the common case) is not an install with usage.
    await mkdir(join(home, 'logs'), { recursive: true });
    expect(await adapter.detect()).toBe(false);
    createStore(dbPath).close();
    expect(await adapter.detect()).toBe(true);
  });

  it('subtracts cache reads and writes from input, keeps output as recorded, and leaks no session text', async () => {
    const db = createStore(dbPath);
    insertEvent(db, {});
    db.close();

    const result = await collect();
    expect(result.source).toBe('copilot-cli');
    expect(result.requestCount).toBe(1);
    expect(result.usage).toHaveLength(1);
    // input 1200 includes 800 read and 100 write: 300 fresh. reasoning_tokens (120) is never added to the 300 output.
    expect(result.usage[0]).toMatchObject({
      date: '2026-09-21',
      model: 'claude-sonnet-4-5',
      pricingTier: 'standard',
      counts: { inputTokens: 300, outputTokens: 300, cacheCreationTokens: 100, cacheReadTokens: 800, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_CWD);
    expect(serialized).not.toContain(SECRET_SUMMARY);
    expect(result.notes).toBeUndefined();
  });

  it('counts every row as its own request, groups by day and model, and keeps the same row id in two sessions apart', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 1);
    insertEvent(db, { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, 2);
    insertEvent(db, { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, createdAt: '2026-09-22 01:00:00' }, 3);
    insertEvent(db, { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, usageModel: 'gpt-5.1-codex', model: 'gpt-5.1-codex' }, 4);
    db.close();

    const result = await collect();
    expect(result.requestCount).toBe(4);
    expect(result.usage.map((u) => [u.date, u.model, u.counts.inputTokens, u.counts.outputTokens])).toEqual([
      ['2026-09-21', 'claude-sonnet-4-5', 300, 30],
      ['2026-09-21', 'gpt-5.1-codex', 7, 1],
      ['2026-09-22', 'claude-sonnet-4-5', 50, 5],
    ]);
  });

  it('dedups by session id plus row id across repeated collects of the same file', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    db.close();
    const first = await collect();
    const second = await collect();
    expect(second).toEqual(first);
    expect(first.requestCount).toBe(1);
  });

  it('prefers copilot_usage_model, falls back to model, then to auto', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { model: 'gpt-5.1', usageModel: 'gpt-5.1-codex', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    insertEvent(db, { model: 'gpt-5.1', usageModel: '  ', input: 20, output: 1, cacheRead: 0, cacheWrite: 0 });
    insertEvent(db, { model: null, usageModel: null, input: 40, output: 1, cacheRead: 0, cacheWrite: 0 });
    insertEvent(db, { model: '', usageModel: null, input: 80, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();

    const result = await collect();
    const byModel = Object.fromEntries(result.usage.map((u) => [u.model, u.counts.inputTokens]));
    expect(byModel).toEqual({ 'gpt-5.1-codex': 10, 'gpt-5.1': 20, auto: 120 });
  });

  it('reads the lean column set (no copilot_usage_model) using model', async () => {
    const db = createStore(dbPath, { columns: LEAN_COLUMNS });
    db.prepare(
      `INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, token_details_json, created_at)
       VALUES ('sess-a', 'claude-opus-4.5', 1000, 50, 400, 0, 10, '{"secret":"x"}', '2026-09-21T18:45:02.000Z')`,
    ).run();
    db.close();

    const result = await collect();
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      date: '2026-09-21',
      model: 'claude-opus-4-5',
      counts: { inputTokens: 600, outputTokens: 50, cacheReadTokens: 400, cacheCreationTokens: 0 },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('never adds reasoning_tokens on top of output', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 40 });
    insertEvent(db, { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 5000 });
    db.close();
    const result = await collect();
    expect(result.usage[0]?.counts.outputTokens).toBe(80);
  });

  it('clamps fresh input at 0 when cache exceeds input and counts it in a note', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: 100, output: 10, cacheRead: 90, cacheWrite: 30 });
    insertEvent(db, { input: 100, output: 10, cacheRead: 10, cacheWrite: 10 });
    db.close();
    const result = await collect();
    expect(result.usage[0]?.counts).toMatchObject({ inputTokens: 80, cacheReadTokens: 100, cacheCreationTokens: 40 });
    expect(result.notes).toEqual(['1 Copilot CLI request(s) reported more cached than total input; counted as 0 fresh input']);
  });

  it('treats NULL counters as 0 and skips all-zero rows silently', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: null, output: 25, cacheRead: null, cacheWrite: null, reasoning: null });
    insertEvent(db, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    insertEvent(db, { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: 9 });
    db.close();
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts).toMatchObject({ inputTokens: 0, outputTokens: 25 });
    expect(result.notes).toBeUndefined();
  });

  it('skips malformed rows (negative or fractional counts, no session id, bad timestamp) and notes them', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: -5 });
    insertEvent(db, { output: 1.5 });
    insertEvent(db, { session: '' });
    insertEvent(db, { createdAt: 'not a date' });
    insertEvent(db, { createdAt: null });
    insertEvent(db, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts.inputTokens).toBe(10);
    expect(result.notes).toEqual(['skipped 5 Copilot CLI record(s) with missing or invalid token counts, session id or timestamp']);
  });

  it('filters by since using the row timestamp, reading space-separated and ISO times as UTC', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, createdAt: '2026-09-20 23:59:59' });
    insertEvent(db, { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, createdAt: '2026-09-21 00:00:00' });
    insertEvent(db, { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, createdAt: '2026-09-21T10:00:00+02:00' });
    insertEvent(db, { input: 8, output: 1, cacheRead: 0, cacheWrite: 0, createdAt: String(Date.parse('2026-09-22T12:00:00Z')) });
    db.close();
    const result = await collect({}, new Date(Date.parse('2026-09-21T00:00:00Z')));
    expect(result.requestCount).toBe(3);
    expect(result.usage.map((u) => [u.date, u.counts.inputTokens])).toEqual([
      ['2026-09-21', 6],
      ['2026-09-22', 8],
    ]);
  });

  it('buckets by the configured time zone', async () => {
    const db = createStore(dbPath);
    insertEvent(db, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, createdAt: '2026-09-21 23:30:00' });
    db.close();
    const result = await collect({ timeZone: 'Asia/Tokyo' });
    expect(result.usage[0]?.date).toBe('2026-09-22');
  });

  it('accepts a store without a schema_version table when the columns match', async () => {
    const db = createStore(dbPath, { version: null });
    insertEvent(db, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();
    expect((await collect()).requestCount).toBe(1);
  });

  it.each([
    ['a newer schema_version', { version: 7 as const }, /schema_version 7/],
    ['an unreadable schema_version', { version: 'text' as const }, /schema_version/],
    ['a missing required column', { columns: 'id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT' }, /cache_read_tokens/],
  ])('skips the whole store with a note for %s', async (_name, options, reason) => {
    const db = createStore(dbPath, options);
    // Written with the columns every variant has, so the row would count if the guard let it through.
    try {
      db.exec(`INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, created_at) VALUES ('s', 'gpt-5.1', 10, 1, '2026-09-21 10:00:00')`);
    } catch {
      /* the variant lacks one of those columns */
    }
    db.close();
    const result = await collect();
    expect(result.usage).toEqual([]);
    expect(result.requestCount).toBe(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes?.[0]).toMatch(/^Copilot CLI's session-store\.db has an unrecognised schema \(/);
    expect(result.notes?.[0]).toMatch(reason);
    expect(result.notes?.[0]).toMatch(/Copilot CLI usage was skipped$/);
  });

  it('notes a store with no assistant_usage_events table (a Copilot CLI older than 1.0.70)', async () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    db.close();
    const result = await collect();
    expect(result.usage).toEqual([]);
    expect(result.notes?.[0]).toMatch(/no assistant_usage_events table/);
  });

  it('reports a file that is not a database as unreadable, without throwing', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dbPath, 'this is not sqlite');
    const result = await collect();
    expect(result.usage).toEqual([]);
    expect(result.notes).toEqual(["Copilot CLI's session-store.db could not be read"]);
  });

  it('opens the store read-only: the file is not modified', async () => {
    const { readFile } = await import('node:fs/promises');
    const db = createStore(dbPath);
    insertEvent(db, {});
    db.close();
    const before = await readFile(dbPath);
    await collect();
    expect((await readFile(dbPath)).equals(before)).toBe(true);
  });

  it('reports Node < 22.13 (no node:sqlite) in a note instead of failing', async () => {
    createStore(dbPath).close();
    const result = await collect({ loadSqlite: async () => null });
    expect(result.usage).toEqual([]);
    expect(result.notes).toEqual([
      `Copilot CLI needs Node 22.13+ to read session-store.db (this is Node ${process.versions.node}); Copilot CLI usage was skipped`,
    ]);
  });
});
