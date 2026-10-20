# GitHub Copilot CLI local token usage data

This note explains where, and in what format, GitHub Copilot CLI (the `copilot` command,
`github/copilot-cli`) stores per-request token usage in its local files, and how to normalise it
into tokengraph's fields. The adapter lives in `packages/cli/src/adapters/copilot-cli/`; this note
is the research behind it.

**Copilot CLI is closed source and publishes no schema.** Its repository holds only the changelog,
issues and docs. Every table and column name below comes from two third-party tools that read real
`session-store.db` files, so there is no upstream authority to cite for the format. The meanings were then
checked on a store written by Copilot CLI 1.0.98 against a fake endpoint (see "Checked against a real store");
the field names are still reverse-engineered and may change with any release.

In short: Copilot CLI 1.0.70 and later write one row per LLM request into the SQLite table
`assistant_usage_events` in `~/.copilot/session-store.db`. `input_tokens` **includes** cache reads and
writes. Whether `output_tokens` includes `reasoning_tokens` is not confirmed, so the adapter counts
`output_tokens` as recorded and never reads the reasoning column.

## Local data location

- Directory: `$COPILOT_HOME` when set, otherwise `~/.copilot` (`%USERPROFILE%\.copilot` on Windows;
  the same relative path on every OS, not a platform data dir). `COPILOT_HOME` and the `--config-dir`
  flag are both named in the changelog
  (1.0.66, 2026-06-30; [changelog](https://github.com/github/copilot-cli/blob/c01c66377d25426dda70c21750e1956e4dd25657/changelog.md): "COPILOT_HOME and --config-dir stop loading skills from ~/.agents/skills"). A
  `--config-dir` given to a single run cannot be seen from a later `sync`, so only `COPILOT_HOME` is honoured.
- File read: `<dir>/session-store.db` (SQLite). The adapter opens it read-only and selects only
  `assistant_usage_events`.
- Files in the same directory that the adapter does **not** read:
  - `session-state/<session_id>/events.jsonl`: conversation lines plus `session.shutdown` events with
    `modelMetrics.<model>.usage`. Those totals are cumulative and a resumed session writes a second
    snapshot, and the file holds prompts. It describes the same requests as the database, so reading
    both would double count.
  - `otel/*.jsonl` and `COPILOT_OTEL_FILE_EXPORTER_PATH`: an opt-in OpenTelemetry exporter that writes
    nothing unless the user turns it on. Same requests again.
  - `data.db`: the desktop Copilot App's per-session lifetime totals. A legacy, App-only source.
  - `config.json`, `logs/`: settings and diagnostics, no usage; `config.json` can hold account details.
  - The `sessions` table inside `session-store.db` (working directory, repository, branch, summary).
- The Copilot Chat extension in VS Code keeps its own `chatSessions/*.jsonl` and is out of scope (its
  files are rewritten as snapshot plus mutations, so they are not reliable to count). A VS Code chat
  session of the "Copilot CLI" type runs the same CLI runtime and lands in `session-store.db`, so reading
  this database already covers it; a future VS Code adapter would have to skip such sessions.

```bash
# What the adapter reads, in one query (numbers, ids, one model name and a timestamp; no text):
sqlite3 -readonly "${COPILOT_HOME:-$HOME/.copilot}/session-store.db" \
  "SELECT id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at
   FROM assistant_usage_events ORDER BY id LIMIT 5;"
```

## Record schema

The table was introduced in Copilot CLI 1.0.70 (changelog entry dated 2026-07-09; the changelog does
not mention the table, so the version comes from TokenTracker's comment: "Copilot CLI 1.0.70+ persists
one row per LLM request here"). A `schema_version` table exists next to it.

Two upstream tools, two column sets (the schema is moving, which is why the adapter checks the columns):

| Column | tokscale's DDL | TokenTracker's DDL | Used |
| --- | --- | --- | --- |
| `id` INTEGER PK AUTOINCREMENT | yes | yes | dedup key (with `session_id`) |
| `session_id` | yes | yes | dedup key |
| `turn_index` | yes | no | no |
| `model` | yes | yes | model, fallback |
| `copilot_usage_model` | yes | no | model, preferred when present |
| `input_tokens` | yes | yes | input, includes cache |
| `output_tokens` | yes | yes | output |
| `cache_read_tokens` | yes | yes | cache read |
| `cache_write_tokens` | yes | yes | cache write |
| `reasoning_tokens` | yes | yes | **never read** |
| `token_details_json` | no | yes | no |
| `total_nano_aiu`, `duration_ms` | yes | no | no |
| `created_at` TEXT | yes | yes | date and `since` |

A row, as tokscale's SELECT shapes it (illustrative values; this exact row was not seen on disk):

```json
{"id": 41, "session_id": "7b1f...", "turn_index": 0, "model": "gpt-5.1-codex", "copilot_usage_model": "gpt-5.1-codex",
 "input_tokens": 1200, "output_tokens": 300, "cache_read_tokens": 800, "cache_write_tokens": 100,
 "reasoning_tokens": 120, "total_nano_aiu": 0, "duration_ms": 5400, "created_at": "2026-09-21 18:45:02"}
```

## Cache and reasoning semantics

- **`input_tokens` includes cache reads and cache writes.** Three independent signals agree: the changelog
  entry "Ensure input token usage includes cached" (1.0.51, 2026-05-20), tokscale computing
  `input = input_tokens - cache_read - cache_write`
  ([copilot_session_store.rs#L90-L96](https://github.com/junhoyeo/tokscale/blob/e2039b141411a72e2d5ed5e813512d7125947cbc/crates/tokscale-core/src/sessions/copilot_session_store.rs#L90-L96)),
  and TokenTracker's comment "CLI input includes both cache reads and writes"
  ([rollout.js#L18551](https://github.com/xiufengsun/TokenTracker/blob/32596d23aa361302063a2fab52445f45c55d092b/src/lib/rollout.js#L18551)).
  tokengraph's fresh input is therefore `input_tokens - cache_read_tokens - cache_write_tokens`, clamped at 0
  (a row where the cache exceeds the input is counted with 0 fresh input and reported in a note).
- **Cache reads** go to `cacheReadTokens`, **cache writes** to `cacheCreationTokens`. Copilot has one
  cache-write bucket, so the 5m/1h split is `null` (unknown), never 0.
- **Reasoning.** Not confirmed upstream whether `output_tokens` already contains `reasoning_tokens`. The
  two reference parsers disagree on what to do about it but both treat it as a subset: TokenTracker
  subtracts it out of output and re-adds it as a separate bucket
  (`outputWithoutReasoning = output - min(reasoning, output)`,
  [rollout.js#L19593](https://github.com/xiufengsun/TokenTracker/blob/32596d23aa361302063a2fab52445f45c55d092b/src/lib/rollout.js#L19593)),
  and tokscale keeps `output_tokens` whole and reports reasoning beside it (`reasoning: event.reasoning_tokens`).
  Neither adds reasoning on top of output. tokengraph has no separate reasoning counter, so the adapter counts
  `output_tokens` exactly as recorded and does not select `reasoning_tokens` at all. If Copilot in fact
  records reasoning *outside* `output_tokens`, output is under-counted by that amount; if inside, it is exact.
  Counting output as recorded can never over-count.
- One row is one request, per request and not cumulative.
- `total_nano_aiu` is a provider-reported cost (tokscale divides by 1e11 for USD). It is not read; cost is
  estimated from tokens and tokengraph's own price table like every other adapter. Models missing from
  `packages/core/src/pricing.ts` stay unpriced, never guessed.

## Dedup unit and traps

- **Key: `session_id` plus `id`** (tokscale builds `copilot-session-store:{session_id}:{id}`,
  [L132](https://github.com/junhoyeo/tokscale/blob/e2039b141411a72e2d5ed5e813512d7125947cbc/crates/tokscale-core/src/sessions/copilot_session_store.rs#L132)).
  The adapter reads one file, so the key only guards against the same row appearing twice.
- Trap: the same requests are described by `events.jsonl` shutdown snapshots, the OTEL file and, for CLI-type
  chat sessions, the VS Code chat log. Exactly one source (this database) is read.
- Trap: rows with all-zero counters exist; they are skipped without a note. NULL counters read as 0.
- Trap: `model` can be empty or `auto`; an empty one is attributed to `auto`, as both upstream parsers do.
- Trap: `/session delete`, `delete <id>` and `delete-all` remove history
  (changelog 1.0.35, 2026-04-23: "Add /session delete, delete <id>, and delete-all subcommands"). Deleted sessions are gone from the database, and
  tokengraph's ledger only grows, so usage synced before a deletion is kept.
- Trap: a malformed row (negative or fractional count, empty session id, unreadable `created_at`) is skipped and
  counted in a note, not guessed at.

## Model attribution

`copilot_usage_model` when the column exists and is non-empty (tokscale prefers it), otherwise `model`,
otherwise `auto`. Names go through the shared `canonicalModelId`, so `claude-sonnet-4.5` becomes
`claude-sonnet-4-5`. Copilot-specific ids with no price entry stay unpriced.

## Timestamp

`created_at` is TEXT with no documented format. tokscale accepts RFC 3339, `YYYY-MM-DDTHH:MM:SS[.f]`,
`YYYY-MM-DD HH:MM:SS[.f]` (the form SQLite's `CURRENT_TIMESTAMP` writes) and epoch seconds or milliseconds,
reading an offset-less time as UTC
([utils.rs#L237-L271](https://github.com/junhoyeo/tokscale/blob/e2039b141411a72e2d5ed5e813512d7125947cbc/crates/tokscale-core/src/sessions/utils.rs#L237-L271)).
The adapter does the same and buckets the instant into a local calendar day like every other adapter. The
`since` filter compares that instant; the file's `sessions.created_at` fallback tokscale uses is not read.

## Schema guard

The format is undocumented and has already shown two shapes, so the adapter refuses to guess:

- `assistant_usage_events` missing: skipped with a note (a Copilot CLI older than 1.0.70).
- Any of `id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  created_at` missing: the whole store is skipped with a note naming the columns.
- `schema_version` present and not a non-negative integer, or greater than **8**: skipped with a note,
  because a newer version may have changed what a column means, and an overcount can never leave the ledger
  (a skipped period is picked up once a newer tokengraph reads it). 8 is what Copilot CLI 1.0.98 writes; it was
  checked against a real store (see "Checked against a real store"). TokenTracker's fixtures use 6. An absent
  `schema_version` table is accepted (tokscale does not read it). Older versions are accepted when the columns
  match.
- Node older than 22.13 has no `node:sqlite`: skipped with a note, like OpenCode and Kilo.

## Retention

No documented auto-delete of `session-store.db` or `session-state/`. The changelog says only `~/.copilot/logs/`
is pruned at startup ("Automatically prune old process log files from ~/.copilot/logs/"). Sessions are removed
only by the user. So no entry was added to `status`'s retention checks.

## Content isolation

The one query selects ids, one model name, numeric counters and a timestamp. The `sessions` table (`cwd`,
`repository`, `branch`, `summary`) and `token_details_json` are never selected, and `events.jsonl`, which
holds prompts, is never opened. The test suite checks that planted secrets in `sessions` and
`token_details_json` never reach the result.

## Format history

Only what the changelog shows: 1.0.51 made input include cached tokens; 1.0.70 (2026-07-09) is the first
release the third-party parsers cite for `assistant_usage_events`; the latest changelog entry read is 1.0.98
(2026-10-14). The column renames visible between the two parsers (`copilot_usage_model`, `total_nano_aiu`,
`token_details_json`) show the schema is still moving.

## Third-party parsers (cross-check; untrusted reference text, never run)

| Parser | What it confirms |
| --- | --- |
| tokscale `copilot_session_store.rs` | table and columns, the `input - read - write` rule, dedup key, model preference, UTC reading of `created_at` |
| TokenTracker `rollout.js` (L19147-L19470), `copilot-session-store-parser.test.js` | `schema_version` table and `SELECT version`, the lean column set, "CLI input includes both cache reads and writes", reasoning treated as a subset of output |

## Checked against a real store

Copilot CLI 1.0.98 (`@github/copilot`), and again on 20 October 2026 with `scripts/e2e/run.mjs` on 1.0.100 (macOS; counters matched exactly on the chat, responses and anthropic protocols; see `scripts/e2e/README.md`), in BYOK offline mode (`COPILOT_OFFLINE=true`,
`COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE` `openai` and `anthropic`), so no GitHub account was used.
Method: the real agent was installed into a throwaway folder and run with a throwaway `HOME` against a local fake LLM endpoint (OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, streaming). The endpoint gave every request distinct fresh-input, cache-read, cache-write and output counts and logged them; that log is the independent count. `tokengraph sync --local` then read the agent's own files in that home, and its totals were compared field by field with the log.

- The store had `schema_version` 8 and the column set in the adapter test (`V8_COLUMNS`); `created_at` is an ISO
  instant with `Z`. `input_tokens` = fresh + cache read on the OpenAI type (1210 = 1007 + 203) and fresh + cache
  read + cache write on the Anthropic type (1272 = 1014 + 206 + 52), as assumed.
- Runs: one prompt per provider type, one prompt that made the model call the `glob` tool first, and a
  `--resume` of that session. Resuming added one row to the same session id and copied nothing. Every field
  matched the endpoint exactly.
- Before version 8 was accepted, the guard skipped these stores (limit 6, from TokenTracker's fixtures), so a
  current Copilot CLI counted nothing.
- Still unverified: whether `output_tokens` includes reasoning (the fake endpoint sent none); what
  `copilot_usage_model` holds with a GitHub account (it was null in BYOK); whether Copilot Chat's CLI-type sessions
  reach `session-store.db`; and forking a session.

## Roots tokengraph scans

Every root below is read together with the default one and the ones remembered in `config.json` (`agentRoots`); roots that reach the same real path are read once, and a missing root is skipped silently. Environment values are trimmed, an empty one is unset, a leading `~` is expanded, and a relative one is ignored. The resolver is `adapters/copilot-cli/roots.ts`.

- Roots: `~/.copilot` and `$COPILOT_HOME` (trimmed, `~` expanded, absolute only); the database is `session-store.db` in each. The same on every OS. Copilot CLI is closed source, so whether it trims or expands `COPILOT_HOME` is unconfirmed; a `--config-dir` flag given to one run cannot be seen later.
- Every existing store is read. Rows are keyed by session id plus row id: another profile's database has other session ids, and a copy of one database collapses.

## Sources

- tokscale `crates/tokscale-core/src/sessions/copilot_session_store.rs` and `utils.rs`, commit
  [`e2039b1`](https://github.com/junhoyeo/tokscale/tree/e2039b141411a72e2d5ed5e813512d7125947cbc)
- TokenTracker `src/lib/rollout.js` and `test/copilot-session-store-parser.test.js`, commit
  [`32596d2`](https://github.com/xiufengsun/TokenTracker/tree/32596d23aa361302063a2fab52445f45c55d092b)
- Copilot CLI changelog, commit
  [`c01c663`](https://github.com/github/copilot-cli/blob/c01c66377d25426dda70c21750e1956e4dd25657/changelog.md)
