import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/** Goose's own schema version (`CURRENT_SCHEMA_VERSION`) when this reader was written. A newer one may have changed what a column means. */
export const MAX_KNOWN_SCHEMA_VERSION = 17;

/** Columns without which a ledger row cannot be turned into a request. `total_tokens`, `cost` and `is_compaction` are never read. */
const REQUIRED_COLUMNS = ['id', 'session_id', 'created_timestamp', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_source'] as const;

/** One `usage_ledger` row exactly as stored, with the session's provider and configured model; the aggregator validates every value. */
export interface LedgerRow {
  id: unknown;
  sessionId: unknown;
  createdTimestamp: unknown;
  model: unknown;
  /** The session's configured model, a fallback for a row without one; null when the column does not exist. */
  sessionModel: unknown;
  /** `sessions.provider_name`; null when the session row or the column is missing. */
  provider: unknown;
  input: unknown;
  output: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
  costSource: unknown;
}

export type LedgerReadResult = { kind: 'rows'; rows: LedgerRow[] } | { kind: 'unsupported'; reason: string };

type Row = Record<string, unknown>;

function columnsOf(db: DatabaseSyncType, table: string): Set<unknown> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return new Set(rows.map((row) => row['name']));
}

/** The `schema_version` problem, or null when the table is absent or the version is known. */
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
 * Reads Goose's `sessions.db` read-only. Only the ledger's counters, ids, model name and timestamp
 * are selected, plus each session's provider name and configured model name: never `messages`,
 * working directories or session names. A schema that is not recognised is reported as
 * `unsupported` instead of being guessed at. Throws on open or query failure; the caller notes it.
 */
export function readLedger(DatabaseSync: typeof DatabaseSyncType, path: string): LedgerReadResult {
  // A short busy timeout instead of failing at once if Goose has the file locked for a write.
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const ledger = columnsOf(db, 'usage_ledger');
    if (ledger.size === 0) return { kind: 'unsupported', reason: 'it has no usage_ledger table (Goose before schema 15 has none)' };
    const missing = REQUIRED_COLUMNS.filter((name) => !ledger.has(name));
    if (missing.length > 0) return { kind: 'unsupported', reason: `usage_ledger lacks ${missing.join(', ')}` };
    const versionProblem = schemaVersionProblem(db);
    if (versionProblem) return { kind: 'unsupported', reason: versionProblem };

    const sessions = columnsOf(db, 'sessions');
    const hasSessions = sessions.has('id');
    const provider = hasSessions && sessions.has('provider_name') ? 's.provider_name' : 'NULL';
    // json_extract throws on malformed JSON, so it is guarded.
    const sessionModel =
      hasSessions && sessions.has('model_config_json')
        ? "CASE WHEN json_valid(s.model_config_json) THEN json_extract(s.model_config_json, '$.model_name') END"
        : 'NULL';
    const join = hasSessions ? 'LEFT JOIN sessions s ON s.id = l.session_id' : '';
    const rows = db
      .prepare(
        `SELECT l.id, l.session_id, l.created_timestamp, l.model, ${sessionModel} AS session_model, ${provider} AS provider,
                l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_write_tokens, l.cost_source
         FROM usage_ledger l ${join} ORDER BY l.id`,
      )
      .all() as Row[];
    return {
      kind: 'rows',
      rows: rows.map((row) => ({
        id: row['id'],
        sessionId: row['session_id'],
        createdTimestamp: row['created_timestamp'],
        model: row['model'],
        sessionModel: row['session_model'],
        provider: row['provider'],
        input: row['input_tokens'],
        output: row['output_tokens'],
        cacheRead: row['cache_read_tokens'],
        cacheWrite: row['cache_write_tokens'],
        costSource: row['cost_source'],
      })),
    };
  } finally {
    db.close();
  }
}
