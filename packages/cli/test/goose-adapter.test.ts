import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGooseAdapter, gooseDbCandidates } from '../src/adapters/goose/index.js';
import { EXCLUDED_PROVIDERS } from '../src/adapters/goose/aggregator.js';
import { loadSqlite } from '../src/adapters/opencode/sqlite.js';

const SINCE = new Date(Date.parse('2026-01-01T00:00:00Z'));
const SECRET_MESSAGE = 'TOP_SECRET_MESSAGE_TEXT';
const SECRET_DIR = '/Users/secretuser/very-secret-project';
// 2026-09-21T18:45:02Z
const T0 = 1_790_016_302;

type Db = InstanceType<typeof DatabaseSyncCtor>;
let DatabaseSync: typeof DatabaseSyncCtor;

beforeAll(async () => {
  const ctor = await loadSqlite();
  if (!ctor) throw new Error('this test suite requires node:sqlite');
  DatabaseSync = ctor;
});

const LEDGER_DDL = `CREATE TABLE usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_timestamp INTEGER NOT NULL, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0)`;

function createDb(path: string, options: { version?: number | null; ledger?: string | null; sessionColumns?: string } = {}): Db {
  const db = new DatabaseSync(path);
  const version = options.version === undefined ? 17 : options.version;
  if (version !== null) {
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  }
  db.exec(`CREATE TABLE sessions (${options.sessionColumns ?? 'id TEXT PRIMARY KEY, provider_name TEXT, model_config_json TEXT, working_dir TEXT, name TEXT'})`);
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, content_json TEXT)');
  if (options.ledger !== null) db.exec(options.ledger ?? LEDGER_DDL);
  db.prepare('INSERT INTO messages (session_id, content_json) VALUES (?, ?)').run('s1', SECRET_MESSAGE);
  return db;
}

function addSession(db: Db, id: string, provider: string | null, modelConfig: string | null = null): void {
  db.prepare('INSERT INTO sessions (id, provider_name, model_config_json, working_dir, name) VALUES (?, ?, ?, ?, ?)').run(id, provider, modelConfig, SECRET_DIR, SECRET_MESSAGE);
}

interface Row {
  session?: string;
  ts?: number;
  model?: string | null;
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  costSource?: string | null;
}

function addRow(db: Db, row: Row = {}): void {
  db.prepare(
    `INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0.5, ?)`,
  ).run(
    row.session ?? 's1',
    row.ts ?? T0,
    row.model === undefined ? 'claude-sonnet-4-5' : row.model,
    row.input === undefined ? 1000 : row.input,
    row.output === undefined ? 200 : row.output,
    row.cacheRead === undefined ? 600 : row.cacheRead,
    row.cacheWrite === undefined ? 100 : row.cacheWrite,
    row.costSource === undefined ? 'estimated' : row.costSource,
  );
}

describe('gooseDbCandidates', () => {
  const keys = ['GOOSE_PATH_ROOT', 'XDG_DATA_HOME'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lists an absolute GOOSE_PATH_ROOT first, then the default locations', () => {
    process.env['GOOSE_PATH_ROOT'] = '/some/root';
    const list = gooseDbCandidates('linux');
    expect(list[0]).toBe(join('/some/root', 'data', 'sessions', 'sessions.db'));
    expect(list).toContain(join(homedir(), '.local', 'share', 'goose', 'sessions', 'sessions.db'));
  });

  it('ignores a relative GOOSE_PATH_ROOT and uses XDG_DATA_HOME, then the legacy folders', () => {
    process.env['GOOSE_PATH_ROOT'] = 'relative/root';
    process.env['XDG_DATA_HOME'] = '/xdg/data';
    const list = gooseDbCandidates('darwin');
    expect(list[0]).toBe(join('/xdg/data', 'goose', 'sessions', 'sessions.db'));
    expect(list.some((path) => path.includes('relative'))).toBe(false);
    // The default ~/.local/share/goose stays in the union, then the three legacy folders.
    expect(list).toHaveLength(5);
    expect(list[2]).toMatch(/Library[\\/]Application Support[\\/]goose[\\/]sessions[\\/]sessions\.db$/);
    expect(list[3]).toMatch(/Application Support[\\/]Block[\\/]goose[\\/]sessions[\\/]sessions\.db$/);
    expect(list[4]).toMatch(/\.local[\\/]share[\\/]Block[\\/]goose[\\/]sessions[\\/]sessions\.db$/);
  });

  it('falls back to ~/.local/share/goose when XDG_DATA_HOME is unset or relative', () => {
    delete process.env['GOOSE_PATH_ROOT'];
    process.env['XDG_DATA_HOME'] = 'rel';
    expect(gooseDbCandidates('linux')[0]).toMatch(/\.local[\\/]share[\\/]goose[\\/]sessions[\\/]sessions\.db$/);
  });
});

describe('createGooseAdapter', () => {
  let root: string;
  let dbPath: string;
  const previousRoot = process.env['GOOSE_PATH_ROOT'];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goose-root-'));
    await mkdir(join(root, 'data', 'sessions'), { recursive: true });
    dbPath = join(root, 'data', 'sessions', 'sessions.db');
    process.env['GOOSE_PATH_ROOT'] = root;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['GOOSE_PATH_ROOT'];
    else process.env['GOOSE_PATH_ROOT'] = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  const collect = (options: Parameters<typeof createGooseAdapter>[0] = {}, since = SINCE) =>
    createGooseAdapter({ timeZone: 'UTC', ...options }).collect(since);

  it('is named goose and is detected only when sessions.db exists', async () => {
    const adapter = createGooseAdapter();
    expect(adapter.name).toBe('goose');
    expect(await adapter.detect()).toBe(false);
    createDb(dbPath).close();
    expect(await adapter.detect()).toBe(true);
  });

  it('turns inclusive input into fresh input, keeps the cache split unknown, and leaks no text', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'anthropic');
    addRow(db);
    db.close();

    const result = await collect();
    expect(result.source).toBe('goose');
    expect(result.requestCount).toBe(1);
    // 300 + 200 + 100 + 0.1 * 600, at 18:45 UTC.
    expect(result.hours).toEqual([{ date: '2026-09-21', hour: 18, weighted: 660 }]);
    // input 1000 includes 600 read and 100 write: 300 fresh.
    expect(result.usage).toEqual([
      {
        date: '2026-09-21',
        model: 'claude-sonnet-4-5',
        pricingTier: 'standard',
        counts: { inputTokens: 300, outputTokens: 200, cacheCreationTokens: 100, cacheReadTokens: 600, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_MESSAGE);
    expect(serialized).not.toContain(SECRET_DIR);
    expect(result.notes).toBeUndefined();
  });

  it('counts each ledger row once, per day and model, and repeated collects agree', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'openai');
    addSession(db, 's2', 'openai');
    addRow(db, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    addRow(db, { input: 200, output: 20, cacheRead: null, cacheWrite: null, session: 's2' });
    addRow(db, { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, ts: T0 + 86_400 });
    addRow(db, { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, model: 'gpt-5.1-codex' });
    db.close();

    const first = await collect();
    expect(first.requestCount).toBe(4);
    expect(first.usage.map((u) => [u.date, u.model, u.counts.inputTokens, u.counts.outputTokens])).toEqual([
      ['2026-09-21', 'claude-sonnet-4-5', 300, 30],
      ['2026-09-21', 'gpt-5.1-codex', 7, 1],
      ['2026-09-22', 'claude-sonnet-4-5', 50, 5],
    ]);
    expect(await collect()).toEqual(first);
  });

  it('skips carried_forward rows and says how many', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'anthropic');
    addRow(db, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    addRow(db, { model: null, input: 9_000_000, output: 9_000_000, cacheRead: 0, cacheWrite: 0, costSource: 'carried_forward' });
    addRow(db, { model: null, input: 5_000_000, output: 1, cacheRead: 0, cacheWrite: 0, costSource: 'carried_forward' });
    db.close();

    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(result.notes).toEqual(['skipped 2 Goose carried-forward row(s): usage from before Goose kept a per-request ledger, with no known day or model']);
  });

  it('skips every wrapper provider whose own agent tokengraph already reads, and counts the rest', async () => {
    expect([...EXCLUDED_PROVIDERS].sort()).toEqual(['claude-acp', 'claude-code', 'codex', 'codex-acp', 'copilot-acp', 'cursor-agent', 'gemini-cli', 'pi-acp']);
    const db = createDb(dbPath);
    const counted = ['anthropic', 'openai', 'amp-acp', 'github_copilot', 'chatgpt_codex', 'kimi_code', 'ollama'];
    for (const provider of [...EXCLUDED_PROVIDERS, ...counted]) {
      addSession(db, `s-${provider}`, provider);
      addRow(db, { session: `s-${provider}`, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    }
    // Provider names are matched case-insensitively and trimmed.
    addSession(db, 's-upper', ' Claude-Code ');
    addRow(db, { session: 's-upper', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();

    const result = await collect();
    expect(result.requestCount).toBe(counted.length);
    expect(result.usage.reduce((sum, u) => sum + u.counts.inputTokens, 0)).toBe(10 * counted.length);
  });

  it('counts rows whose session is missing or has no provider', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', null);
    addRow(db, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    addRow(db, { session: 'gone', input: 20, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();
    expect((await collect()).requestCount).toBe(2);
  });

  it('skips a row whose cache exceeds its input (unknown, not 0) and notes it', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'anthropic');
    addRow(db, { input: 100, output: 10, cacheRead: 90, cacheWrite: 30 });
    addRow(db, { input: 100, output: 10, cacheRead: 10, cacheWrite: 10 });
    db.close();
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts).toMatchObject({ inputTokens: 80, cacheReadTokens: 10, cacheCreationTokens: 10 });
    expect(result.notes).toEqual(['skipped 1 Goose request(s) whose cached tokens exceeded their input (the split is unknown)']);
  });

  it('takes the model from the session config when the row has none, else skips and notes', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'openai', JSON.stringify({ model_name: 'gpt-5.1' }));
    addSession(db, 's2', 'openai', '{not json');
    addSession(db, 's3', 'openai', null);
    addRow(db, { model: null, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    addRow(db, { model: '  ', session: 's2', input: 20, output: 1, cacheRead: 0, cacheWrite: 0 });
    addRow(db, { model: null, session: 's3', input: 40, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();
    const result = await collect();
    expect(result.usage.map((u) => [u.model, u.counts.inputTokens])).toEqual([['gpt-5.1', 10]]);
    expect(result.notes).toEqual(['skipped 2 Goose request(s) with no model name']);
  });

  it('skips all-zero rows silently and malformed rows with a note', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'anthropic');
    addRow(db, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    addRow(db, { input: null, output: null, cacheRead: null, cacheWrite: null });
    addRow(db, { input: -5 });
    addRow(db, { output: 1.5 });
    addRow(db, { ts: 0 });
    addRow(db, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();
    const result = await collect();
    expect(result.requestCount).toBe(1);
    expect(result.notes).toEqual(['skipped 3 Goose record(s) with invalid token counts or timestamp']);
  });

  it('reads a millisecond timestamp as milliseconds', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'anthropic');
    addRow(db, { ts: T0 * 1000, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    db.close();
    expect((await collect()).usage[0]?.date).toBe('2026-09-21');
  });

  it('filters by since', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'anthropic');
    addRow(db, { ts: T0 - 10 * 86_400, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    addRow(db, { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 });
    db.close();
    const result = await collect({}, new Date((T0 - 86_400) * 1000));
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts.inputTokens).toBe(20);
  });

  it('notes a database without usage_ledger (Goose before the ledger) instead of reading anything', async () => {
    const db = createDb(dbPath, { ledger: null });
    addSession(db, 's1', 'anthropic');
    db.close();
    const result = await collect();
    expect(result.usage).toEqual([]);
    expect(result.notes?.[0]).toMatch(/unrecognised schema \(it has no usage_ledger table/);
  });

  it('skips a ledger missing a required column and a schema_version newer than 17', async () => {
    let db = createDb(dbPath, { ledger: 'CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT)' });
    db.close();
    let result = await collect();
    expect(result.notes?.[0]).toMatch(/usage_ledger lacks created_timestamp, input_tokens/);
    await rm(dbPath);

    db = createDb(dbPath, { version: 18 });
    addSession(db, 's1', 'anthropic');
    addRow(db);
    db.close();
    result = await collect();
    expect(result.usage).toEqual([]);
    expect(result.notes?.[0]).toMatch(/schema_version 18 is newer than 17/);
  });

  it('accepts a database with no schema_version table', async () => {
    const db = createDb(dbPath, { version: null });
    addSession(db, 's1', 'anthropic');
    addRow(db);
    db.close();
    expect((await collect()).requestCount).toBe(1);
  });

  it('works without sessions.model_config_json', async () => {
    const db = createDb(dbPath, { sessionColumns: 'id TEXT PRIMARY KEY, provider_name TEXT' });
    db.prepare('INSERT INTO sessions (id, provider_name) VALUES (?, ?)').run('s1', 'anthropic');
    addRow(db);
    db.close();
    expect((await collect()).requestCount).toBe(1);
  });

  it('notes an unreadable database and a Node without node:sqlite', async () => {
    const db = createDb(dbPath);
    addSession(db, 's1', 'anthropic');
    addRow(db);
    db.close();
    const noSqlite = await collect({ loadSqlite: async () => null });
    expect(noSqlite.usage).toEqual([]);
    expect(noSqlite.notes?.[0]).toMatch(/Goose needs Node 22\.13\+/);

    await rm(dbPath);
    await (await import('node:fs/promises')).writeFile(dbPath, 'this is not a database');
    const broken = await collect();
    expect(broken.notes).toEqual(["Goose's sessions.db could not be read"]);
  });

  it('reads only the first existing database and returns nothing when there is none', async () => {
    const result = await collect();
    expect(result.usage).toEqual([]);
    expect(result.notes).toBeUndefined();
  });
});

describe('createGooseAdapter over several roots', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'goose-roots-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** A Goose data dir (`<dir>/sessions/sessions.db`) holding the given session's rows. */
  async function dataDir(name: string, session: string, rows: Row[]): Promise<string> {
    const dir = join(base, name);
    await mkdir(join(dir, 'sessions'), { recursive: true });
    const db = createDb(join(dir, 'sessions', 'sessions.db'));
    addSession(db, session, 'anthropic');
    for (const row of rows) addRow(db, { ...row, session });
    db.close();
    return dir;
  }

  const collectFrom = (remembered: string[]) =>
    createGooseAdapter({ timeZone: 'UTC', roots: { ctx: { platform: process.platform, env: {}, home: join(base, 'no-home') }, remembered } }).collect(SINCE);

  it('reads every existing database: a profile and the default folder add up', async () => {
    const first = await dataDir('default', '20260921_1', [{ input: 1000, output: 100 }]);
    const second = await dataDir('profile', '20260921_2', [{ input: 2000, output: 200 }, { input: 900, output: 50, ts: T0 + 5 }]);
    const result = await collectFrom([first, second]);
    expect(result.requestCount).toBe(3);
    expect(result.usage[0]?.counts.outputTokens).toBe(350);
  });

  it('counts a copy of a database once, wherever the copy sits', async () => {
    const original = await dataDir('default', '20260921_1', [{ input: 1000, output: 100 }, { input: 700, output: 70, ts: T0 + 9 }]);
    const backup = join(base, 'backup');
    await mkdir(join(backup, 'sessions'), { recursive: true });
    await copyFile(join(original, 'sessions', 'sessions.db'), join(backup, 'sessions', 'sessions.db'));
    const result = await collectFrom([original, backup]);
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]?.counts.outputTokens).toBe(170);
  });

  it('reads one database once when two roots reach it (a symlinked profile)', async () => {
    const original = await dataDir('default', '20260921_1', [{ input: 1000, output: 100 }]);
    const link = join(base, 'link');
    try {
      await symlink(original, link, 'dir');
    } catch {
      return; // Symlinks need a privilege on some Windows setups.
    }
    const result = await collectFrom([original, link]);
    expect(result.requestCount).toBe(1);
  });

  it('skips a remembered root that no longer exists without a note', async () => {
    const original = await dataDir('default', '20260921_1', [{ input: 1000, output: 100 }]);
    const result = await collectFrom([original, join(base, 'deleted')]);
    expect(result.requestCount).toBe(1);
    expect(result.notes).toBeUndefined();
  });
});
