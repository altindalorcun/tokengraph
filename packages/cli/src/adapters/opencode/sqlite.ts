import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { OpenCodeAggregator } from './aggregator.js';

/** `sinceMs` is coarsened this far back before it reaches SQL, so a boundary row is never dropped by the DB-side pre-filter (see `readOpenCodeDatabase`). */
const COARSE_FILTER_MARGIN_MS = 86_400_000;

let warningSilenced = false;

/**
 * Suppresses only `node:sqlite`'s `ExperimentalWarning` so `sync`'s output stays pristine; every
 * other warning still goes through untouched. Idempotent — safe to call before every import.
 */
function silenceSqliteWarning(): void {
  if (warningSilenced) return;
  warningSilenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.includes('SQLite')) return;
    return (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** `node:sqlite`'s `DatabaseSync` constructor, or null when this Node has no `node:sqlite` (< 22.13, matching the note printed for the user). */
export async function loadSqlite(): Promise<typeof DatabaseSyncType | null> {
  silenceSqliteWarning();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return DatabaseSync;
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;

/** A JSON field read through `json_extract`: absent (SQL NULL — the path didn't exist) vs. present (a JSON-text value, possibly malformed). */
type JsonField = { present: false } | { present: true; value: unknown };

/** `json_extract` of an object/array returns JSON text; anything else (missing path) is SQL NULL. */
function jsonField(raw: unknown): JsonField {
  if (raw === null || raw === undefined) return { present: false };
  if (typeof raw !== 'string') return { present: true, value: null };
  try {
    return { present: true, value: JSON.parse(raw) };
  } catch {
    // Present but malformed: the caller passes `null` tokens through so the aggregator counts
    // it invalid, rather than dropping it silently as a genuinely absent field would be.
    return { present: true, value: null };
  }
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asMsOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tableNames(db: DatabaseSyncType): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[];
  return new Set(rows.map((row) => row['name'] as string));
}

function readSessions(db: DatabaseSyncType, aggregator: OpenCodeAggregator): void {
  const rows = db.prepare('SELECT id, version, time_created FROM session').all() as Row[];
  for (const row of rows) {
    aggregator.addSession({
      id: row['id'] as string,
      version: asStringOrNull(row['version']),
      createdMs: asMsOrNull(row['time_created']),
    });
  }
}

/** Every step-finish part's tokens, grouped by `message_id`, ordered by part id (`ORDER BY message_id, id` in SQL). */
function readSteps(db: DatabaseSyncType, bound: number): Map<string, unknown[]> {
  const rows = db
    .prepare(
      `SELECT id, message_id, json_extract(data, '$.tokens') AS tokens
       FROM part
       WHERE time_created >= ? AND json_extract(data, '$.type') = 'step-finish'
       ORDER BY message_id, id`,
    )
    .all(bound) as Row[];

  const steps = new Map<string, unknown[]>();
  for (const row of rows) {
    const messageId = row['message_id'] as string;
    const field = jsonField(row['tokens']);
    // A step-finish part is only ever written with its tokens already filled in; a missing field
    // here is unexpected, so it is passed through as `null` (an invalid record), not dropped.
    const tokens = field.present ? field.value : null;
    const existing = steps.get(messageId);
    if (existing) existing.push(tokens);
    else steps.set(messageId, [tokens]);
  }
  return steps;
}

function readV1Messages(db: DatabaseSyncType, aggregator: OpenCodeAggregator, bound: number, stepsByMessage: Map<string, unknown[]>): void {
  const rows = db
    .prepare(
      `SELECT id, session_id, time_created,
              json_extract(data, '$.providerID') AS provider_id,
              json_extract(data, '$.modelID') AS model_id,
              json_extract(data, '$.time.created') AS created,
              json_extract(data, '$.time.completed') AS completed,
              json_extract(data, '$.agent') AS agent,
              json_extract(data, '$.cost') AS cost,
              json_extract(data, '$.tokens') AS tokens
       FROM message
       WHERE time_created >= ? AND json_extract(data, '$.role') = 'assistant'`,
    )
    .all(bound) as Row[];

  for (const row of rows) {
    const id = row['id'] as string;
    const steps = stepsByMessage.get(id) ?? [];
    const tokensField = jsonField(row['tokens']);
    // Missing tokens on a message with no steps at all is an in-flight/aborted assistant
    // message: there is no request unit to build from it, so it is skipped silently rather
    // than passed to the aggregator as an invalid record.
    if (steps.length === 0 && !tokensField.present) continue;

    aggregator.addV1Message({
      id,
      sessionId: row['session_id'] as string,
      providerId: asStringOrNull(row['provider_id']),
      modelId: asStringOrNull(row['model_id']),
      createdMs: asMsOrNull(row['created']) ?? asMsOrNull(row['time_created']) ?? 0,
      completedMs: asMsOrNull(row['completed']),
      agent: asStringOrNull(row['agent']),
      cost: typeof row['cost'] === 'number' ? row['cost'] : null,
      tokens: tokensField.present ? tokensField.value : null,
      steps,
    });
  }
}

function readV2Messages(db: DatabaseSyncType, aggregator: OpenCodeAggregator, bound: number): void {
  const rows = db
    .prepare(
      `SELECT id,
              json_extract(data, '$.model.providerID') AS provider_id,
              json_extract(data, '$.model.id') AS model_id,
              json_extract(data, '$.time.created') AS created,
              json_extract(data, '$.time.completed') AS completed,
              json_extract(data, '$.agent') AS agent,
              json_extract(data, '$.cost') AS cost,
              json_extract(data, '$.tokens') AS tokens,
              type, time_created,
              json_extract(data, '$.status') AS status
       FROM session_message
       WHERE time_created >= ? AND type IN ('assistant', 'compaction')`,
    )
    .all(bound) as Row[];

  for (const row of rows) {
    const status = asStringOrNull(row['status']);
    // Only a completed compaction row carries real usage; an in-progress or errored one does
    // not and is skipped (a `status`-less row — assistant rows never carry one — is kept).
    if (row['type'] === 'compaction' && status !== null && status !== 'completed') continue;

    const tokensField = jsonField(row['tokens']);
    // Missing tokens (an in-flight row still streaming, or a title-only row) has nothing to
    // count and is skipped silently, not passed through as an invalid record.
    if (!tokensField.present) continue;

    aggregator.addV2Message({
      id: row['id'] as string,
      providerId: asStringOrNull(row['provider_id']),
      modelId: asStringOrNull(row['model_id']),
      createdMs: asMsOrNull(row['created']) ?? asMsOrNull(row['time_created']) ?? 0,
      completedMs: asMsOrNull(row['completed']),
      agent: asStringOrNull(row['agent']),
      cost: typeof row['cost'] === 'number' ? row['cost'] : null,
      tokens: tokensField.value,
    });
  }
}

/**
 * Reads one `opencode*.db` read-only into `aggregator`. Only counters, ids, model/provider ids
 * and timestamps are ever selected — never `content`, `path`, `directory` or `title`. Throws on
 * open or query failure; the caller notes it as an unreadable source and moves on.
 */
export function readOpenCodeDatabase(DatabaseSync: typeof DatabaseSyncType, path: string, aggregator: OpenCodeAggregator, sinceMs: number): void {
  // A short busy timeout instead of failing immediately if OpenCode itself has the file locked
  // for a write at the same moment sync runs.
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const tables = tableNames(db);
    const bound = sinceMs - COARSE_FILTER_MARGIN_MS;

    if (tables.has('session')) readSessions(db, aggregator);

    if (tables.has('message')) {
      const stepsByMessage = tables.has('part') ? readSteps(db, bound) : new Map<string, unknown[]>();
      readV1Messages(db, aggregator, bound, stepsByMessage);
    }

    if (tables.has('session_message')) readV2Messages(db, aggregator, bound);
  } finally {
    db.close();
  }
}
