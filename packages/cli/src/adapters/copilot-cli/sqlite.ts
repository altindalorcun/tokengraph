import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/** Highest `schema_version` this reader was written against (the value TokenTracker's fixtures use). A newer one may have changed what a column means. */
export const MAX_KNOWN_SCHEMA_VERSION = 6;

/** Columns without which a row cannot be turned into a request. `reasoning_tokens` is deliberately not one: it is never read. */
const REQUIRED_COLUMNS = ['id', 'session_id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'created_at'] as const;

/** One `assistant_usage_events` row exactly as stored; the aggregator validates every value. */
export interface UsageEventRow {
  id: unknown;
  sessionId: unknown;
  model: unknown;
  /** Only present in newer stores; null when the column does not exist. */
  usageModel: unknown;
  input: unknown;
  output: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
  createdAt: unknown;
}

export type StoreReadResult = { kind: 'rows'; rows: UsageEventRow[] } | { kind: 'unsupported'; reason: string };

type Row = Record<string, unknown>;

/** The `schema_version` problem, or null when the version is absent (not every build has the table) or known. */
function schemaVersionProblem(db: DatabaseSyncType): string | null {
  const hasTable = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='schema_version'").all().length > 0;
  if (!hasTable) return null;
  const rows = db.prepare('SELECT version FROM schema_version LIMIT 1').all() as Row[];
  const version = rows[0]?.['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return 'its schema_version is not a number';
  if (version > MAX_KNOWN_SCHEMA_VERSION) return `schema_version ${version} is newer than ${MAX_KNOWN_SCHEMA_VERSION}, the newest this reader knows`;
  return null;
}

/**
 * Reads Copilot CLI's `session-store.db` read-only. Only the usage counters, ids, model names and
 * the timestamp of `assistant_usage_events` are selected — never the `sessions` table (working
 * directory, branch, summary) or any prompt text. A schema that is not recognised is reported as
 * `unsupported` instead of being guessed at. Throws on open or query failure; the caller notes
 * it as an unreadable source.
 */
export function readUsageEvents(DatabaseSync: typeof DatabaseSyncType, path: string): StoreReadResult {
  // A short busy timeout instead of failing at once if Copilot CLI has the file locked for a write.
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const columns = db.prepare('PRAGMA table_info(assistant_usage_events)').all() as Row[];
    if (columns.length === 0) {
      return { kind: 'unsupported', reason: 'it has no assistant_usage_events table (Copilot CLI 1.0.70 first wrote it)' };
    }
    const names = new Set(columns.map((column) => column['name']));
    const missing = REQUIRED_COLUMNS.filter((name) => !names.has(name));
    if (missing.length > 0) return { kind: 'unsupported', reason: `assistant_usage_events lacks ${missing.join(', ')}` };
    const versionProblem = schemaVersionProblem(db);
    if (versionProblem) return { kind: 'unsupported', reason: versionProblem };

    const usageModel = names.has('copilot_usage_model') ? 'copilot_usage_model' : 'NULL';
    const rows = db
      .prepare(
        `SELECT id, session_id, model, ${usageModel} AS usage_model, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, created_at
         FROM assistant_usage_events ORDER BY id`,
      )
      .all() as Row[];
    return {
      kind: 'rows',
      rows: rows.map((row) => ({
        id: row['id'],
        sessionId: row['session_id'],
        model: row['model'],
        usageModel: row['usage_model'],
        input: row['input_tokens'],
        output: row['output_tokens'],
        cacheRead: row['cache_read_tokens'],
        cacheWrite: row['cache_write_tokens'],
        createdAt: row['created_at'],
      })),
    };
  } finally {
    db.close();
  }
}
