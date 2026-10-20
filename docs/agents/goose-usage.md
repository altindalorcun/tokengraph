# Goose local token usage data

This note explains where, and in what format, Goose (the open-source agent from Block, now
`aaif-goose/goose`; Rust, Apache-2.0) stores per-request token usage, and how to normalise it into
tokengraph's fields. The adapter lives in `packages/cli/src/adapters/goose/`. Every name below was read
from the upstream source at commit [`34a222e`](https://github.com/aaif-goose/goose/tree/34a222e3f2b95d8b4a43482b53c2cc957ecce26d)
(schema version 17).

In short: Goose keeps all sessions in one SQLite file, `sessions.db`. Since schema 15 the table
`usage_ledger` holds one row per provider call. `input_tokens` **includes** cache reads and writes.
The adapter reads that table and nothing else of substance.

## Local data location

- File: `<data_dir>/sessions/sessions.db` (WAL mode). `DB_NAME` and `SESSIONS_FOLDER` are in
  `crates/goose/src/session/session_manager.rs` (L31-L34); the path is built in `SessionStorage::new` (L1074).
- `data_dir` is `Paths::data_dir()` (`crates/goose-local-inference/src/paths.rs`):
  - `$GOOSE_PATH_ROOT/data` when `GOOSE_PATH_ROOT` is set **and absolute** (a relative value is ignored);
  - otherwise etcetera's app strategy for `Block`/`goose`: Linux and macOS use XDG, so
    `$XDG_DATA_HOME/goose` or `~/.local/share/goose` (not `~/Library/Application Support` on current builds);
    Windows uses `%APPDATA%\Block\goose\data`.
- Older builds left databases in `~/Library/Application Support/goose`, `~/Library/Application Support/Block/goose`
  and `~/.local/share/Block/goose` (from the token-monitor note `docs/providers/goose.md`, not from Goose's source).
  The adapter reads **every existing** candidate (see "Roots tokengraph scans"); it used to read only the first.
  A database that cannot be read is noted, and the others are still read.
- Goose imports pre-SQLite JSONL sessions into the same database on first run (`import_legacy`).

```bash
# What the adapter reads, in one query (numbers, ids, a model name, a timestamp, a provider name; no text):
sqlite3 -readonly "${XDG_DATA_HOME:-$HOME/.local/share}/goose/sessions/sessions.db" \
  "SELECT l.id, l.session_id, l.created_timestamp, l.model, l.input_tokens, l.output_tokens,
          l.cache_read_tokens, l.cache_write_tokens, l.cost_source, s.provider_name
   FROM usage_ledger l LEFT JOIN sessions s ON s.id = l.session_id ORDER BY l.id LIMIT 5;"
```

## Record schema

`usage_ledger` (created fresh at L1200 and by migration 15 at L1697):

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
created_timestamp INTEGER NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0
```

`record_usage_metrics` (L2538-L2622, called from `agents/state_machine/usage.rs`) inserts one row per
provider call through `insert_usage_ledger_row` (L1014), copying `MessageUsage::from_provider_usage`
(`goose-provider-types/src/conversation/message.rs` L803). Used columns: `id`, `session_id`,
`created_timestamp`, `model`, the four token counts, `cost_source`. Not read: `total_tokens` (may be NULL),
`cost` (tokengraph estimates cost from its own price table), `is_compaction` (a compaction call is a real
request and is counted). From `sessions`: `provider_name` and `model_config_json` (`$.model_name` only).

Illustrative row (not seen on disk):

```json
{"id": 41, "session_id": "20261003_1", "created_timestamp": 1790016302, "model": "claude-sonnet-4-5",
 "input_tokens": 1000, "output_tokens": 200, "cache_read_tokens": 600, "cache_write_tokens": 100,
 "cost_source": "estimated", "is_compaction": 0}
```

## Cache and reasoning semantics

- **`input_tokens` includes cache reads and writes.** `Usage` documents it
  (`goose-provider-types/src/conversation/token_usage.rs` L99-L110: "All prompt tokens, including any served from or
  written to cache. `cache_read_input_tokens` and `cache_write_input_tokens` are subsets of this"), and providers that
  report cache separately (Anthropic, Bedrock) are folded in with `from_cache_exclusive_input` (L185-L203).
  Fresh input is `input - cache_read - cache_write`. A negative result means the row does not follow that convention
  (for example an older build); the row is skipped as unknown and counted in a note, never clamped to 0.
- Cache reads go to `cacheReadTokens`, cache writes to `cacheCreationTokens`. There is one cache-write count, so the
  5m/1h split is `null`, never 0.
- NULL counts read as 0. Reasoning is not recorded in the ledger and is assumed to be inside `output_tokens`; it is
  never inferred from `total - input - output` (tokscale's guess).
- One row is one request, not cumulative. `sessions.accumulated_*` are cumulative and not read.

## Dedup unit and traps

- **Key: the session id, `usage_ledger.id` (autoincrement) and `created_timestamp`.** The row id alone is only unique within one database; the session id and timestamp make a copy of the database (a backup, a copied data folder) collapse instead of counting twice. Repeated collects of the same file agree.
- **Trap, `carried_forward` rows.** When `sessions.accumulated_*` exceeds the ledger sum (a session older than the
  ledger, or an imported one), the next call first inserts a synthetic delta row with `cost_source = 'carried_forward'`
  and no model (L2548-L2570). Its timestamp is the day of the next request, not when the tokens were spent. These rows
  are skipped and counted in a note; counting them would put a lump on one arbitrary day.
- **Trap, `import_session`** copies `accumulated_usage` into the new session (L2716-L2750), which would duplicate
  usage from another machine; those lumps arrive as `carried_forward` rows and are skipped. `copy_session` does not
  copy usage (L2761-L2800).
- **Trap, `delete_session`** removes the session's ledger rows (L2490). tokengraph's ledger only grows, so usage
  synced before a deletion is kept.
- Subagent sessions have their own rows (`parent_session_id`); they are separate sessions, not copies.
- Rows with all-zero counters are skipped silently. A negative or fractional count, or a timestamp that is not a
  positive number, is malformed: skipped and counted.

## Wrapper providers (usage another adapter already counts)

Goose can drive other agents as providers; `sessions.provider_name` names the provider (constants in
`crates/goose/src/providers/*.rs`). Those requests also appear in the wrapped agent's own logs. Decision per provider:

| Provider name | Wraps | Decision |
| --- | --- | --- |
| `claude-code`, `claude-acp` | Claude Code | excluded (Claude Code adapter) |
| `codex`, `codex-acp` | Codex CLI | excluded (Codex adapter) |
| `gemini-cli` | Gemini CLI | excluded (Gemini CLI adapter) |
| `cursor-agent` | Cursor's CLI | excluded (Cursor adapter), with a gap: the Cursor adapter's only source is the event file written by tokengraph's Cursor `stop` hook. It is not verified that this hook fires for `cursor-agent --print` runs started by Goose, so without the hook, or if it does not fire, such Goose requests are counted by neither adapter. Double counting was judged worse than this disclosed undercount |
| `copilot-acp` | Copilot CLI | excluded (Copilot CLI adapter) |
| `pi-acp` | pi | excluded (pi adapter) |
| `amp-acp` | Amp | counted: no tokengraph adapter reads Amp (threads are server-side). Goose's ACP rows carry the model name `current` (`ACP_CURRENT_MODEL`, `acp/provider.rs` L52), so they show under that model, unpriced |
| `github_copilot` | Copilot API over HTTP | counted: a direct API client, not the CLI, so no Copilot CLI log mirrors it |
| `chatgpt_codex`, `kimi_code` | HTTP APIs | counted: not mirrored in any local agent log |
| every other provider | direct API | counted |

No ACP wrapper for Qwen Code, Kilo or OpenCode exists upstream (the ACP providers are `claude_acp`, `codex_acp`,
`copilot_acp`, `amp_acp`, `pi_acp`). Names are compared trimmed and case-insensitively. The list is
`EXCLUDED_PROVIDERS` in `aggregator.ts`. The exclusions assume the wrapped CLI runs on this same machine and writes the logs tokengraph reads here. A row whose session or provider is missing is counted. Caveat: the provider is
session-level and can change mid-session, while the ledger has no provider column, so a session that switched providers
is attributed by its last provider (the residual risk is small).

## Model attribution

`usage_ledger.model` (the provider-reported model), else `sessions.model_config_json` `$.model_name` (guarded with
`json_valid`), else the row is skipped and counted. Names go through `canonicalModelId`. Models without a price entry stay unpriced.

## Timestamp

`created_timestamp` is `strftime('%s','now')` at insert: UTC unix seconds. Goose itself treats a stored value above
10 000 000 000 as milliseconds (`MILLISECOND_TIMESTAMP_THRESHOLD`, L35), and the adapter does the same. The instant is
bucketed into a local calendar day like every other adapter; `since` compares that instant.

## Schema guard

- No `usage_ledger` table (Goose before schema 15): skipped with a note. A pre-15 database gets only a
  `carried_forward` lump once upgraded, so its data is unknown, not 0.
- Any of `id, session_id, created_timestamp, model, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_source` missing: skipped with a note naming the columns.
- `schema_version` above **17** (`CURRENT_SCHEMA_VERSION` when read): skipped with a note, since a newer version may
  change a column's meaning. An absent `schema_version` table is accepted. A missing `sessions` table or
  `provider_name` / `model_config_json` column only removes the provider exclusion or the model fallback.
- Node older than 22.13 has no `node:sqlite`: skipped with a note.

## Retention

No retention or auto-delete: only `archived_at`, which hides a session without deleting it. The user can delete
sessions. No entry was added to `status`'s retention checks.

## Content isolation

The one query selects ids, a model name, numeric counters, a timestamp, `cost_source`, a provider name and the
model name inside `model_config_json`. `messages.content_json`, working directories and session names are never
selected. The database is opened read-only. WAL: a read-only open of a WAL database still needs the `-shm` file, and
the token-monitor note records that read-only scans on macOS can touch it; accepted. The test suite checks that planted
secrets in `messages` and `sessions` never reach the result.

## Format history

Ledger introduced by migration 15; the exact Goose release is not determinable from a shallow clone. Current
schema is 17. Whether the inclusive-input convention held for every build before the unified `Usage` struct is not
checkable here; the negative-input guard is the mitigation.

## Checked against real runs

Goose 1.55.0 (the `goose-aarch64-apple-darwin` release binary). Method: the real agent was installed into a throwaway folder and run with a throwaway `HOME` against a local fake LLM endpoint (OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, streaming). The endpoint gave every request distinct fresh-input, cache-read, cache-write and output counts and logged them; that log is the independent count. `tokengraph sync --local` then read the agent's own files in that home, and its totals were compared field by field with the log.

- Providers: `openai` (which used the Responses API for `gpt-5.4`) and `anthropic`, both with a custom host,
  `goose run -t`, plus one prompt that made the model call the `shell` tool first. Every `usage_ledger` row matched
  the request it came from exactly, so `input_tokens` includes cache read and cache write as assumed.
- **Gap: the session-naming request.** Each new session's first request asks the model for a session name. It is
  not in `usage_ledger` or `sessions` (Goose's own totals miss it too). It appears only in the rotating debug
  logs `~/.local/state/goose/logs/llm_request.<n>.jsonl`, which keep the last few requests and hold full prompts,
  so they are not read. The undercount is one short request per session.
- Still unverified: the legacy macOS and Linux locations (from a third-party note, not Goose's source); whether
  the Cursor `stop` hook fires for `cursor-agent --print` runs started by Goose (without it, those requests are
  counted by neither adapter); whether `copilot --acp` writes `assistant_usage_events` (the exclusion assumes
  it does); and old builds (before schema 15, and the input convention before it was unified).

## Roots tokengraph scans

Every root below is read together with the default one and the ones remembered in `config.json` (`agentRoots`); roots that reach the same real path are read once, and a missing root is skipped silently. Environment values are trimmed, an empty one is unset, a leading `~` is expanded, and a relative one is ignored. The resolver is `adapters/goose/roots.ts`.

- Data folders, each read through `sessions/sessions.db`: Linux `~/.local/share/goose` (+ legacy `~/.local/share/Block/goose`); macOS the same plus `~/Library/Application Support/goose` and `~/Library/Application Support/Block/goose`; Windows `%APPDATA%\Block\goose\data` (falling back to `<home>\AppData\Roaming`). Environment adds `$GOOSE_PATH_ROOT/data` (absolute only, as in Goose) and `$XDG_DATA_HOME/goose` (absolute only, as in etcetera).
- Decision, every existing database is read (it used to be the first one found, an absolute `GOOSE_PATH_ROOT` excluding the rest). Reading all of them is what makes profiles add up. The legacy folders hold databases from before the usage ledger existed (schema 15), so they contribute no rows in practice, and Goose does not copy databases between folders (its `import_legacy` moves pre-SQLite JSONL into the same database).
- Because copies of one database can still exist (a backup, a copied `GOOSE_PATH_ROOT`), a request is keyed by session id, ledger row id and timestamp, not by the database path it came from: the same row read from two copies collapses, and two unrelated databases would need the same session id, row id and second to collide.

## Sources

- Goose `crates/goose/src/session/session_manager.rs`, `crates/goose-provider-types/src/conversation/{token_usage,message}.rs`,
  `crates/goose-local-inference/src/paths.rs`, `crates/goose/src/providers/*.rs`, `crates/goose/src/acp/provider.rs`, commit
  [`34a222e`](https://github.com/aaif-goose/goose/tree/34a222e3f2b95d8b4a43482b53c2cc957ecce26d)
- token-monitor `docs/providers/goose.md` (legacy paths and WAL note; untrusted reference text, never run)
