import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKiloAdapter } from '../src/adapters/kilo/index.js';
import { loadSqlite } from '../src/adapters/opencode/sqlite.js';

const SESSION_CREATED = Date.parse('2026-09-01T00:00:00Z');
const CREATED = Date.parse('2026-09-27T10:00:00Z');
const SINCE = new Date(Date.parse('2026-01-01T00:00:00Z'));
const SECRET_DIRECTORY = '/Users/secretuser/very-secret-project';
const SECRET_TEXT = 'TOP_SECRET_PROMPT_TEXT_SHOULD_NEVER_LEAK';

type Db = InstanceType<typeof DatabaseSyncCtor>;
let DatabaseSync: typeof DatabaseSyncCtor;

beforeAll(async () => {
  const ctor = await loadSqlite();
  if (!ctor) throw new Error('this test suite requires node:sqlite');
  DatabaseSync = ctor;
});

function tokens(input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0, total?: number) {
  return { input, output, reasoning, ...(total === undefined ? {} : { total }), cache: { read: cacheRead, write: cacheWrite } };
}

function assistantData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4.5',
    agent: 'code',
    cost: 0.01,
    time: { created: CREATED, completed: CREATED + 1000 },
    tokens: tokens(0, 0),
    ...overrides,
  };
}

function stepFinishData(stepTokens: unknown, model?: { providerID: string; modelID: string }): Record<string, unknown> {
  return { type: 'step-finish', cost: 0.005, tokens: stepTokens, ...(model ? { model } : {}) };
}

function createDb(path: string, withV2 = false): Db {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session (id text primary key, version text not null, time_created integer not null, directory text not null, title text not null)`);
  db.exec(`CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)`);
  db.exec(`CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)`);
  if (withV2) {
    db.exec(`CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)`);
  }
  return db;
}

function insertSession(db: Db, id: string, version: string, timeCreated = SESSION_CREATED): void {
  db.prepare('INSERT INTO session (id, version, time_created, directory, title) VALUES (?, ?, ?, ?, ?)').run(
    id,
    version,
    timeCreated,
    SECRET_DIRECTORY,
    'secret session title',
  );
}

function insertMessage(db: Db, id: string, sessionId: string, data: unknown, timeCreated = CREATED): void {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, timeCreated, timeCreated, JSON.stringify(data));
}

function insertPart(db: Db, id: string, messageId: string, sessionId: string, data: unknown, timeCreated = CREATED): void {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    messageId,
    sessionId,
    timeCreated,
    timeCreated,
    JSON.stringify(data),
  );
}

/** One message with one step-finish part carrying the same tokens, the way Kilo writes a single-step turn. */
function insertTurn(db: Db, id: string, sessionId: string, tokensValue: unknown, overrides: Record<string, unknown> = {}, model?: { providerID: string; modelID: string }): void {
  insertMessage(db, id, sessionId, assistantData({ tokens: tokensValue, ...overrides }), (overrides['time'] as { created: number } | undefined)?.created ?? CREATED);
  insertPart(db, `prt_${id}`, id, sessionId, stepFinishData(tokensValue, model));
}

describe('createKiloAdapter', () => {
  let dataDir: string;
  let kiloDir: string;
  const previousXdgDataHome = process.env['XDG_DATA_HOME'];
  const previousKiloDb = process.env['KILO_DB'];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kilo-data-'));
    kiloDir = join(dataDir, 'kilo');
    await mkdir(kiloDir, { recursive: true });
    process.env['XDG_DATA_HOME'] = dataDir;
    delete process.env['KILO_DB'];
  });

  afterEach(async () => {
    if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME'];
    else process.env['XDG_DATA_HOME'] = previousXdgDataHome;
    if (previousKiloDb === undefined) delete process.env['KILO_DB'];
    else process.env['KILO_DB'] = previousKiloDb;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('is named kilo and is not detected with an empty data dir', async () => {
    const adapter = createKiloAdapter();
    expect(adapter.name).toBe('kilo');
    expect(await adapter.detect()).toBe(false);
  });

  it('reads kilo.db: two step-finish parts are two requests, reasoning is added to output, and no text or paths leak', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.8.14');
    insertMessage(db, 'msg_1', 's1', assistantData({ tokens: tokens(30, 20, 0, 0, 0) }));
    insertPart(db, 'prt_1', 'msg_1', 's1', stepFinishData(tokens(10, 5, 100, 20, 7)));
    insertPart(db, 'prt_2', 'msg_1', 's1', stepFinishData(tokens(30, 20, 0, 0, 0)));
    insertMessage(db, 'msg_user', 's1', { role: 'user', time: { created: CREATED } });
    insertPart(db, 'prt_text', 'msg_1', 's1', { type: 'text', text: SECRET_TEXT });
    db.close();

    const adapter = createKiloAdapter({ timeZone: 'UTC' });
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(SINCE);

    expect(result.source).toBe('kilo');
    expect(result.requestCount).toBe(2);
    // (10 + 12 + 20 + 10) + (30 + 20), at 10:00 UTC.
    expect(result.hours).toEqual([{ date: '2026-09-27', hour: 10, weighted: 102 }]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      date: '2026-09-27',
      model: 'claude-sonnet-4-5',
      counts: { inputTokens: 40, outputTokens: 32, cacheCreationTokens: 20, cacheReadTokens: 100, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_DIRECTORY);
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(result.notes).toBeUndefined();
  });

  it('does not apply the OpenCode 1.3.16 threshold: a 7.2.4 session with a total is read by arithmetic, not as reasoning-separate', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.2.4');
    // I=100, O=50 (already includes reasoning 10), CR=20, T=170: output stays 50. Reading it as period D would give 60.
    insertTurn(db, 'msg_1', 's1', tokens(100, 50, 20, 0, 10, 170));
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 } });
  });

  it('switches to reasoning-separate exactly at 7.2.6', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's5', '7.2.5');
    insertSession(db, 's6', '7.2.6');
    insertTurn(db, 'msg_5', 's5', tokens(100, 50, 20, 0, 10, 170), { time: { created: CREATED, completed: CREATED + 1 } });
    insertTurn(db, 'msg_6', 's6', tokens(100, 40, 20, 0, 10), { time: { created: CREATED + 10, completed: CREATED + 11 } });
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 40 } });
  });

  it('skips and reports a pre-7.2.6 record that has cache but no total', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.1.0');
    insertTurn(db, 'msg_1', 's1', tokens(100, 50, 20, 0, 0));
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(0);
    expect(result.notes).toContain('skipped 1 Kilo request(s) from before v7.2.6 whose token fields cannot be interpreted with certainty');
  });

  it('does not use the AI SDK 6 skip window: a cache record in the OpenCode window is counted', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    const created = Date.parse('2026-04-01T10:00:00Z');
    insertSession(db, 's1', '7.2.4', Date.parse('2026-03-01T00:00:00Z'));
    insertTurn(db, 'msg_1', 's1', tokens(100, 50, 20, 0, 0, 170), { time: { created, completed: created + 1 } });
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ date: '2026-04-01', counts: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 } });
    expect(result.notes).toBeUndefined();
  });

  it('prefers the routed model on a step-finish part and falls back to the message model without one', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.8.14');
    insertMessage(db, 'msg_1', 's1', assistantData({ modelID: 'kilo-auto/frontier', tokens: tokens(5, 5) }));
    insertPart(db, 'prt_1', 'msg_1', 's1', stepFinishData(tokens(10, 5), { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4.5' }));
    insertPart(db, 'prt_2', 'msg_1', 's1', stepFinishData(tokens(5, 5)));
    insertMessage(db, 'msg_2', 's1', assistantData({ modelID: 'minimax/m2.5', time: { created: CREATED + 50, completed: CREATED + 60 }, tokens: tokens(1, 1) }), CREATED + 50);
    insertPart(db, 'prt_3', 'msg_2', 's1', stepFinishData(tokens(1, 1)), CREATED + 50);
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    const byModel = new Map(result.usage.map((row) => [row.model, row.counts]));
    expect(byModel.get('claude-sonnet-4-5')).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(byModel.get('kilo-auto/frontier')).toMatchObject({ inputTokens: 5, outputTokens: 5 });
    expect(byModel.get('minimax/m2.5')).toMatchObject({ inputTokens: 1, outputTokens: 1 });
    expect(result.requestCount).toBe(3);
  });

  it('counts a fork clone (new id, identical fields) only once', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.8.14');
    insertSession(db, 's2', '7.8.14');
    insertTurn(db, 'msg_a', 's1', tokens(10, 5));
    insertTurn(db, 'msg_b', 's2', tokens(10, 5));
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 10, outputTokens: 5 } });
  });

  it('skips the claude-code provider with a note, and the zero-token legacy-migration provider silently', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.8.14');
    insertTurn(db, 'msg_cc', 's1', tokens(10, 5), { providerID: 'claude-code', time: { created: CREATED + 1, completed: CREATED + 2 } });
    insertTurn(db, 'msg_legacy', 's1', tokens(0, 0), { providerID: 'legacy', modelID: 'legacy', time: { created: CREATED + 3, completed: CREATED + 3 } });
    insertTurn(db, 'msg_ok', 's1', tokens(7, 3));
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 7, outputTokens: 3 } });
    expect(result.notes).toEqual(['skipped 1 request(s) made through the claude-code provider (already counted from Claude Code)']);
  });

  it('reports a malformed token record and keeps the good ones', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.8.14');
    insertTurn(db, 'msg_bad', 's1', { input: 'ten', output: 5 }, { time: { created: CREATED + 1, completed: CREATED + 2 } });
    insertTurn(db, 'msg_ok', 's1', tokens(7, 3));
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.notes).toContain('skipped 1 Kilo record(s) with missing or invalid token counts');
  });

  it('honours since', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.8.14');
    insertTurn(db, 'msg_old', 's1', tokens(10, 5), { time: { created: Date.parse('2026-02-01T10:00:00Z'), completed: Date.parse('2026-02-01T10:00:01Z') } });
    insertTurn(db, 'msg_new', 's1', tokens(7, 3));
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(new Date(Date.parse('2026-09-01T00:00:00Z')));
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ date: '2026-09-27', counts: { inputTokens: 7, outputTokens: 3 } });
  });

  it('reads a kilo-<channel>.db and a pre-existing opencode-<channel>.db, but not an unrelated opencode.db', async () => {
    for (const [name, id] of [
      ['kilo-dev.db', 'msg_k'],
      ['opencode-dev.db', 'msg_o'],
      ['opencode.db', 'msg_x'],
    ] as const) {
      const db = createDb(join(kiloDir, name));
      insertSession(db, 's1', '7.8.14');
      insertTurn(db, id, 's1', tokens(10, 5), { time: { created: CREATED + name.length, completed: CREATED + name.length + 1 } });
      db.close();
    }

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(2);
  });

  it('reads the database KILO_DB names (relative to the data dir) in addition to the data dir\'s own', async () => {
    for (const name of ['kilo.db', 'custom.db']) {
      const db = createDb(join(kiloDir, name));
      insertSession(db, 's1', '7.8.14');
      insertTurn(db, `msg_${name}`, 's1', tokens(name === 'custom.db' ? 3 : 10, 1), { time: { created: CREATED + name.length, completed: CREATED + name.length + 1 } });
      db.close();
    }
    process.env['KILO_DB'] = 'custom.db';

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    // kilo.db and custom.db are different databases with different messages: both count, custom.db once.
    expect(result.requestCount).toBe(2);
    expect(result.usage.reduce((sum, row) => sum + row.counts.inputTokens, 0)).toBe(13);
  });

  it('ignores a JSON storage folder (Kilo releases before kilo.db are a different format)', async () => {
    await mkdir(join(kiloDir, 'storage'), { recursive: true });
    await writeFile(join(kiloDir, 'storage', 'note.json'), '{}');
    expect(await createKiloAdapter().detect()).toBe(false);
  });

  it('reads session_message rows as reasoning-separate usage', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'), true);
    insertSession(db, 's1', '7.8.14');
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'v2msg_1',
      's1',
      'assistant',
      1,
      CREATED,
      CREATED,
      JSON.stringify({ agent: 'code', cost: 0.01, model: { providerID: 'kilo', id: 'minimax/m2.5' }, time: { created: CREATED, completed: CREATED + 1 }, tokens: tokens(7, 3, 0, 0, 2) }),
    );
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ model: 'minimax/m2.5', counts: { inputTokens: 7, outputTokens: 5 } });
  });

  it('notes a corrupt db file as unreadable', async () => {
    await writeFile(join(kiloDir, 'kilo.db'), 'not a database');
    const result = await createKiloAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(0);
    expect(result.notes).toContain('1 Kilo database(s) or file(s) could not be read');
  });

  it('notes that Node lacks node:sqlite', async () => {
    const db = createDb(join(kiloDir, 'kilo.db'));
    insertSession(db, 's1', '7.8.14');
    insertTurn(db, 'msg_1', 's1', tokens(10, 5));
    db.close();

    const result = await createKiloAdapter({ timeZone: 'UTC', loadSqlite: async () => null }).collect(SINCE);
    expect(result.requestCount).toBe(0);
    expect(result.notes).toContain(`Kilo needs Node 22.13+ to read kilo.db (this is Node ${process.versions.node}); Kilo usage was skipped`);
  });
});
