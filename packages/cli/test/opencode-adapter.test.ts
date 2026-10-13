import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOpenCodeAdapter } from '../src/adapters/opencode/index.js';
import { loadSqlite } from '../src/adapters/opencode/sqlite.js';

const SESSION_CREATED = Date.parse('2026-09-01T00:00:00Z');
const CREATED = Date.parse('2026-09-27T10:00:00Z');
const SINCE = new Date(Date.parse('2026-01-01T00:00:00Z'));
const SECRET_DIRECTORY = '/Users/secretuser/very-secret-project';
const SECRET_TEXT = 'TOP_SECRET_PROMPT_TEXT_SHOULD_NEVER_LEAK';

let DatabaseSync: typeof DatabaseSyncCtor;

beforeAll(async () => {
  const ctor = await loadSqlite();
  if (!ctor) throw new Error('this test suite requires node:sqlite');
  DatabaseSync = ctor;
});

function tokens(input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0) {
  return { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } };
}

function assistantData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    agent: 'build',
    cost: 0.01,
    time: { created: CREATED, completed: CREATED + 1000 },
    tokens: tokens(0, 0),
    ...overrides,
  };
}

function stepFinishData(input: number, output: number, cacheRead = 0, cacheWrite = 0): Record<string, unknown> {
  return { type: 'step-finish', cost: 0.005, tokens: tokens(input, output, cacheRead, cacheWrite) };
}

function createV1Db(path: string): InstanceType<typeof DatabaseSyncCtor> {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session (id text primary key, version text not null, time_created integer not null, directory text not null, title text not null)`);
  db.exec(`CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)`);
  db.exec(`CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)`);
  return db;
}

function createV2Db(path: string): InstanceType<typeof DatabaseSyncCtor> {
  const db = createV1Db(path);
  db.exec(
    `CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)`,
  );
  return db;
}

function insertSession(
  db: InstanceType<typeof DatabaseSyncCtor>,
  { id, version, timeCreated, directory = SECRET_DIRECTORY, title = 'secret session title' }: { id: string; version: string; timeCreated: number; directory?: string; title?: string },
): void {
  db.prepare('INSERT INTO session (id, version, time_created, directory, title) VALUES (?, ?, ?, ?, ?)').run(id, version, timeCreated, directory, title);
}

function insertMessage(
  db: InstanceType<typeof DatabaseSyncCtor>,
  { id, sessionId, timeCreated = CREATED, data }: { id: string; sessionId: string; timeCreated?: number; data: unknown },
): void {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    timeCreated,
    timeCreated,
    JSON.stringify(data),
  );
}

function insertPart(
  db: InstanceType<typeof DatabaseSyncCtor>,
  { id, messageId, sessionId, timeCreated = CREATED, data }: { id: string; messageId: string; sessionId: string; timeCreated?: number; data: unknown },
): void {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    messageId,
    sessionId,
    timeCreated,
    timeCreated,
    JSON.stringify(data),
  );
}

function insertSessionMessage(
  db: InstanceType<typeof DatabaseSyncCtor>,
  { id, sessionId, type, seq = 0, timeCreated = CREATED, data }: { id: string; sessionId: string; type: string; seq?: number; timeCreated?: number; data: unknown },
): void {
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    type,
    seq,
    timeCreated,
    timeCreated,
    JSON.stringify(data),
  );
}

describe('createOpenCodeAdapter', () => {
  let dataDir: string;
  const previousXdgDataHome = process.env['XDG_DATA_HOME'];
  const previousOpencodeDb = process.env['OPENCODE_DB'];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'opencode-data-'));
    process.env['XDG_DATA_HOME'] = dataDir;
    delete process.env['OPENCODE_DB'];
  });

  afterEach(async () => {
    if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME'];
    else process.env['XDG_DATA_HOME'] = previousXdgDataHome;
    if (previousOpencodeDb === undefined) delete process.env['OPENCODE_DB'];
    else process.env['OPENCODE_DB'] = previousOpencodeDb;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('is not detected with an empty data dir', async () => {
    expect(await createOpenCodeAdapter().detect()).toBe(false);
  });

  it('reads a v1 db (two step-finish parts as two requests) and never leaks the session directory or message text', async () => {
    const opencodeDir = join(dataDir, 'opencode');
    await mkdir(opencodeDir, { recursive: true });
    const db = createV1Db(join(opencodeDir, 'opencode.db'));
    insertSession(db, { id: 's1', version: '1.18.32', timeCreated: SESSION_CREATED });
    insertMessage(db, { id: 'msg_1', sessionId: 's1', data: assistantData({ tokens: tokens(30, 20) }) });
    insertPart(db, { id: 'prt_1', messageId: 'msg_1', sessionId: 's1', data: stepFinishData(10, 5) });
    insertPart(db, { id: 'prt_2', messageId: 'msg_1', sessionId: 's1', data: stepFinishData(30, 20) });
    // A user message: never selected (role != 'assistant').
    insertMessage(db, { id: 'msg_user', sessionId: 's1', data: { role: 'user', time: { created: CREATED } } });
    // A non-step-finish part holding secret text: never selected (type != 'step-finish').
    insertPart(db, { id: 'prt_text', messageId: 'msg_1', sessionId: 's1', data: { type: 'text', text: SECRET_TEXT } });
    db.close();

    const adapter = createOpenCodeAdapter({ timeZone: 'UTC' });
    expect(adapter.name).toBe('opencode');
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(SINCE);

    expect(result.requestCount).toBe(2);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({ date: '2026-09-27', model: 'claude-sonnet-4-5', counts: { inputTokens: 40, outputTokens: 25 } });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_DIRECTORY);
    expect(serialized).not.toContain(SECRET_TEXT);
  });

  it('prefers the db copy of a message also present in JSON storage (more steps wins)', async () => {
    const opencodeDir = join(dataDir, 'opencode');
    await mkdir(opencodeDir, { recursive: true });

    // Older JSON copy: 1 step.
    const storageDir = join(opencodeDir, 'storage');
    await mkdir(join(storageDir, 'session', 'proj1'), { recursive: true });
    await mkdir(join(storageDir, 'message', 's1'), { recursive: true });
    await mkdir(join(storageDir, 'part', 'msg_1'), { recursive: true });
    await writeFile(join(storageDir, 'session', 'proj1', 's1.json'), JSON.stringify({ version: '1.18.32', time: { created: SESSION_CREATED } }));
    await writeFile(join(storageDir, 'message', 's1', 'msg_1.json'), JSON.stringify(assistantData({ tokens: tokens(10, 5) })));
    await writeFile(join(storageDir, 'part', 'msg_1', 'prt_1.json'), JSON.stringify(stepFinishData(10, 5)));

    // Newer db copy: 2 steps.
    const db = createV1Db(join(opencodeDir, 'opencode.db'));
    insertSession(db, { id: 's1', version: '1.18.32', timeCreated: SESSION_CREATED });
    insertMessage(db, { id: 'msg_1', sessionId: 's1', data: assistantData({ tokens: tokens(30, 20) }) });
    insertPart(db, { id: 'prt_1', messageId: 'msg_1', sessionId: 's1', data: stepFinishData(10, 5) });
    insertPart(db, { id: 'prt_2', messageId: 'msg_1', sessionId: 's1', data: stepFinishData(30, 20) });
    db.close();

    const result = await createOpenCodeAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 40, outputTokens: 25 } });
  });

  it('reads JSON-only history when there is no db at all', async () => {
    const opencodeDir = join(dataDir, 'opencode');
    const storageDir = join(opencodeDir, 'storage');
    await mkdir(join(storageDir, 'session', 'proj1'), { recursive: true });
    await mkdir(join(storageDir, 'message', 's1'), { recursive: true });
    await mkdir(join(storageDir, 'part', 'msg_1'), { recursive: true });
    await writeFile(join(storageDir, 'session', 'proj1', 's1.json'), JSON.stringify({ version: '1.18.32', time: { created: SESSION_CREATED } }));
    await writeFile(join(storageDir, 'message', 's1', 'msg_1.json'), JSON.stringify(assistantData({ tokens: tokens(10, 5) })));
    await writeFile(join(storageDir, 'part', 'msg_1', 'prt_1.json'), JSON.stringify(stepFinishData(10, 5)));

    const adapter = createOpenCodeAdapter({ timeZone: 'UTC' });
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 10, outputTokens: 5 } });
  });

  it('counts a message present identically in opencode.db and opencode-beta.db only once', async () => {
    const opencodeDir = join(dataDir, 'opencode');
    await mkdir(opencodeDir, { recursive: true });

    for (const name of ['opencode.db', 'opencode-beta.db']) {
      const db = createV1Db(join(opencodeDir, name));
      insertSession(db, { id: 's1', version: '1.18.32', timeCreated: SESSION_CREATED });
      insertMessage(db, { id: 'msg_dup', sessionId: 's1', data: assistantData({ tokens: tokens(10, 5) }) });
      insertPart(db, { id: 'prt_1', messageId: 'msg_dup', sessionId: 's1', data: stepFinishData(10, 5) });
      db.close();
    }

    const result = await createOpenCodeAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 10, outputTokens: 5 } });
  });

  it('drops a v2 row that shares a v1 message id, and counts a v2-only assistant row', async () => {
    const opencodeDir = join(dataDir, 'opencode');
    await mkdir(opencodeDir, { recursive: true });
    const db = createV2Db(join(opencodeDir, 'opencode.db'));
    insertSession(db, { id: 's1', version: '1.18.32', timeCreated: SESSION_CREATED });
    insertMessage(db, { id: 'msg_shared', sessionId: 's1', data: assistantData({ tokens: tokens(10, 5) }) });
    insertPart(db, { id: 'prt_1', messageId: 'msg_shared', sessionId: 's1', data: stepFinishData(10, 5) });
    // A v2 migration copy of the v1 message: same id, different (bogus) tokens — must be dropped, not counted.
    insertSessionMessage(db, {
      id: 'msg_shared',
      sessionId: 's1',
      type: 'assistant',
      data: { agent: 'build', cost: 0.5, model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' }, time: { created: CREATED, completed: CREATED + 1000 }, tokens: tokens(999, 999) },
    });
    // A genuine v2-only assistant row, at its own distinct time so it doesn't collide with the
    // shared-id row's identity (createdMs/completedMs/providerId/modelId/agent).
    insertSessionMessage(db, {
      id: 'v2msg_1',
      sessionId: 's1',
      type: 'assistant',
      seq: 1,
      data: { agent: 'build', cost: 0.01, model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' }, time: { created: CREATED + 5000, completed: CREATED + 6000 }, tokens: tokens(7, 3) },
    });
    db.close();

    const result = await createOpenCodeAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(2);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 17, outputTokens: 8 } });
  });

  it('notes a corrupt db file as unreadable, while still counting JSON storage', async () => {
    const opencodeDir = join(dataDir, 'opencode');
    const storageDir = join(opencodeDir, 'storage');
    await mkdir(join(storageDir, 'session', 'proj1'), { recursive: true });
    await mkdir(join(storageDir, 'message', 's1'), { recursive: true });
    await mkdir(join(storageDir, 'part', 'msg_1'), { recursive: true });
    await writeFile(join(storageDir, 'session', 'proj1', 's1.json'), JSON.stringify({ version: '1.18.32', time: { created: SESSION_CREATED } }));
    await writeFile(join(storageDir, 'message', 's1', 'msg_1.json'), JSON.stringify(assistantData({ tokens: tokens(10, 5) })));
    await writeFile(join(storageDir, 'part', 'msg_1', 'prt_1.json'), JSON.stringify(stepFinishData(10, 5)));
    await writeFile(join(opencodeDir, 'opencode.db'), 'not a database');

    const result = await createOpenCodeAdapter({ timeZone: 'UTC' }).collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]).toMatchObject({ counts: { inputTokens: 10, outputTokens: 5 } });
    expect(result.notes?.some((note) => note.includes('could not be read'))).toBe(true);
  });

  it('notes that Node lacks node:sqlite and skips every db when loadSqlite is unavailable', async () => {
    const opencodeDir = join(dataDir, 'opencode');
    await mkdir(opencodeDir, { recursive: true });
    const db = createV1Db(join(opencodeDir, 'opencode.db'));
    insertSession(db, { id: 's1', version: '1.18.32', timeCreated: SESSION_CREATED });
    insertMessage(db, { id: 'msg_1', sessionId: 's1', data: assistantData({ tokens: tokens(10, 5) }) });
    insertPart(db, { id: 'prt_1', messageId: 'msg_1', sessionId: 's1', data: stepFinishData(10, 5) });
    db.close();

    const result = await createOpenCodeAdapter({ timeZone: 'UTC', loadSqlite: async () => null }).collect(SINCE);
    expect(result.requestCount).toBe(0);
    expect(result.usage).toHaveLength(0);
    expect(result.notes).toContain(`OpenCode needs Node 22.13+ to read opencode.db (this is Node ${process.versions.node}); OpenCode usage was skipped`);
  });
});
