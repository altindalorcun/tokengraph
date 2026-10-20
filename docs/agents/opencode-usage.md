# OpenCode local token usage data

This note explains how we can read per-request token usage from the local files of OpenCode
(anomalyco/opencode, formerly sst/opencode; opencode.ai) and how it can be normalised into
tokengraph's four fields. The adapter lives in `packages/cli/src/adapters/opencode/`; this note is
the research behind it (27 September 2026). OpenCode was not installed on the research machine then.
Everything below was worked out from the source code (git history included), the official
documentation and two independent third-party parsers. OpenCode 1.19.3 has since been run against a fake
LLM server (see `## Checked against real runs`); older versions were not (see `## Checked against real runs

OpenCode 1.19.3, 20 October 2026, macOS, with `scripts/e2e/run.mjs` (see `scripts/e2e/README.md`): the real agent in
a throwaway `HOME` against a fake LLM server on the chat, responses and anthropic protocols; a one-shot prompt, a
resumed session and a tool loop per protocol. After `sync --local`, input, output, cache read and cache write
matched the server's log per model, once the title-generation requests (the requests that offer no tools) were
left out, as documented above. Not run: older versions (including the pre-1.3.16 rules), the `storage/` layout and
real providers.

## Not verified`).

The counters OpenCode stores are local session usage; they are not a provider bill. OpenCode's own
`cost` field is also an estimate and must not be used in tokengraph (see `## The cost field`).

## Two release lines

As of September 2026 two separate product lines are published from the same repository; they share
**the same data directory and the same SQLite file**:

| Line | Distribution | Latest version | Message tables |
| --- | --- | --- | --- |
| v1 | npm `opencode-ai` (the GitHub "latest" release), brew, install script | 1.18.32 (21 September 2026) | `session`, `message`, `part` |
| v2 | npm `@opencode/cli` (git tag `v2.0.x`, the `v2` branch; no GitHub release) | 2.0.18 (25 September 2026) | `session_v2`, `session_message` (+ the v1 tables stay as a source) |

The vast majority of users are on the v1 line. The main sections below describe v1; v2 has its own
section (`## The v2 line`).

## Local data location

The data directory is determined with `xdg-basedir`, and the XDG layout is used regardless of the
operating system (on macOS it is **not** `~/Library/...`):

```text
DATA = ${XDG_DATA_HOME:-$HOME/.local/share}/opencode
# Windows: %USERPROFILE%\.local\share\opencode  (when XDG_DATA_HOME is not set)
```

- v1: `packages/core/src/global.ts` → `path.join(xdgData, "opencode")`; v2:
  `packages/util/src/global-roots.ts` applies the same rule by hand. The official
  [troubleshooting documentation](https://opencode.ai/docs/troubleshooting/) also says `~/.local/share/opencode/` for macOS/Linux and
  `%USERPROFILE%\.local\share\opencode` for Windows.
- **The database file** (v1 `packages/core/src/database/database.ts` `path()`, v2
  `packages/cli/src/database-path.ts`):
  - If the `OPENCODE_DB` environment variable is set: an absolute path is used as is, a relative
    one is resolved against `DATA`. (If it is `:memory:`, nothing is written to disk.)
  - Otherwise, if the install channel is `latest`/`beta`/`prod` (in v2 also `dev`/`next`), it is
    `DATA/opencode.db`; for another channel (for example the v1 `dev` build, snapshots) it is
    `DATA/opencode-<channel>.db`. `OPENCODE_DISABLE_CHANNEL_DB=1|true` turns off the channel
    suffix.
  - Old v2 previews used `DATA/opencode-next.db`; v2.0.x migrates it once into `opencode.db`
    (keeping the ids).
- **The old JSON store** (<= 1.1.x): under `DATA/storage/`, each record is a separate JSON file:
  - `storage/session/<projectID>/<sessionID>.json`
  - `storage/message/<sessionID>/<messageID>.json`
  - `storage/part/<messageID>/<partID>.json`
  - Even older versions (before about v0.3) used the layout
    `DATA/project/<slug>/storage/session/{info,message,part}/...`; the `Storage` migration in
    1.1.x moved these to the layout above.
- Files such as `auth.json`, `mcp-auth.json` and `log/` are not needed for this job and must never
  be read.

The database is opened in WAL mode (`PRAGMA journal_mode = WAL`); while OpenCode is running there
are `opencode.db-wal` / `-shm` files. The reader must open it read-only and must not ignore the
`-wal`, so that it can see rows in the WAL that have not been checkpointed yet.

```bash
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
ls "$DATA"/opencode*.db "$DATA/storage" 2>/dev/null

# Counters only; does not print prompt/answer text.
sqlite3 -readonly "$DATA/opencode.db" "
  SELECT m.id, m.session_id,
         json_extract(m.data,'$.providerID')      AS provider,
         json_extract(m.data,'$.modelID')         AS model,
         json_extract(m.data,'$.time.created')    AS created_ms,
         json_extract(m.data,'$.tokens')          AS tokens
  FROM message m
  WHERE json_extract(m.data,'$.role') = 'assistant'
  LIMIT 5;"

# step-finish totals per message
sqlite3 -readonly "$DATA/opencode.db" "
  SELECT message_id, count(*) AS steps,
         sum(json_extract(data,'$.tokens.input'))      AS input,
         sum(json_extract(data,'$.tokens.output'))     AS output,
         sum(json_extract(data,'$.tokens.reasoning'))  AS reasoning,
         sum(json_extract(data,'$.tokens.cache.read')) AS cache_read,
         sum(json_extract(data,'$.tokens.cache.write'))AS cache_write
  FROM part WHERE json_extract(data,'$.type') = 'step-finish'
  GROUP BY message_id LIMIT 5;"
```

The official CLI has `opencode db path` (prints the database path) and `opencode stats` (its own
token/cost summary) commands ([CLI documentation](https://opencode.ai/docs/cli/)).

## Migration from JSON to SQLite

- SQLite arrived with **v1.2.0** (14 February 2026). On first start, if `DATA/opencode.db` does not
  exist, `JsonMigration.run()` copies all the JSON files under
  `storage/{project,session,message,part,...}` into the database in one go
  (`onConflictDoNothing`, the ids are kept as they are). The JSON files are **not deleted**; they
  stay on disk after the migration but are no longer updated.
- The JSON migration code was removed in **v1.16.0** (5 June 2026, commit `ca2acc4f8`, "remove
  JSON storage migration"). For a user who jumps straight from <= 1.1.x to >= 1.16, the JSON
  history is never migrated into the database; it only stays under `storage/`.
- Consequence: an adapter must read both `opencode*.db` and `storage/message` + `storage/part`,
  and merge them by **message id** (if the same id exists in both sources, the SQLite copy is more
  up to date and is preferred).

## The v1 SQLite schema

`packages/core/src/session/sql.ts` (v1.18.32). JSON columns are stored as `text`. `message.data`
and `part.data` are the record with the `id`/`sessionID`/`messageID` fields **removed**
(`projector.ts` `messageData()`/`partData()`); these identifiers must be read from the columns.

```sql
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, workspace_id text,
  parent_id text,              -- the parent of a sub-agent (task) session
  slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL,
  version text NOT NULL,       -- the OpenCode version that created the session
  ...,
  cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer ..., tokens_reasoning integer ..., tokens_cache_read integer ...,
  tokens_cache_write integer ...,   -- running total of the step-finish parts (v1.15+)
  model text,                  -- JSON {id, providerID, variant}; the session's last model
  time_created integer NOT NULL, time_updated integer NOT NULL,
  time_compacting integer, time_archived integer
);
CREATE TABLE message (
  id text PRIMARY KEY,         -- "msg_…" (time-ordered, unique)
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  time_created integer NOT NULL, time_updated integer NOT NULL,
  data text NOT NULL           -- SessionV1.Info (User | Assistant), without id/sessionID
);
CREATE TABLE part (
  id text PRIMARY KEY,         -- "prt_…"
  message_id text NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL,
  data text NOT NULL           -- SessionV1.Part, without id/sessionID/messageID
);
```

### Assistant message (`message.data`, `role = "assistant"`)

The schema is `packages/schema/src/v1/session.ts` `Assistant`. The example is **derived from the
schema** and is not a real record (the values were chosen to be consistent):

```json
{
  "role": "assistant",
  "parentID": "msg_9f1c2a7b3001Qz8XkR1vT0aBcD",
  "providerID": "anthropic",
  "modelID": "claude-sonnet-4-5",
  "mode": "build",
  "agent": "build",
  "variant": "default",
  "path": { "cwd": "/Users/me/proj", "root": "/Users/me/proj" },
  "time": { "created": 1790000000000, "completed": 1790000012345 },
  "cost": 0.032439,
  "tokens": {
    "total": 50570,
    "input": 12,
    "output": 812,
    "reasoning": 0,
    "cache": { "read": 48210, "write": 1536 }
  },
  "finish": "tool-calls"
}
```

Optional fields: `error` (Abort/API/ContextOverflow...), `summary: true` (the compaction summary
message), `structured`, `finish`. `tokens.total` does not exist before v1.1.57.

### step-finish part (`part.data`, `type = "step-finish"`)

```json
{
  "type": "step-finish",
  "reason": "tool-calls",
  "snapshot": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "cost": 0.032439,
  "tokens": {
    "total": 50570,
    "input": 12,
    "output": 812,
    "reasoning": 0,
    "cache": { "read": 48210, "write": 1536 }
  }
}
```

In the old JSON store the same objects are separate files that additionally carry the `id`,
`sessionID` (and, on a part, `messageID`) fields.

## How the records are written (one request = one step)

Source: `packages/opencode/src/session/processor.ts` (`case "step-finish"`) and the `prompt.ts`
loop.

- The prompt loop creates a **new** assistant message for each LLM call (`tokens` starts at
  zeros), then processes the stream.
- When the provider finishes each step: `assistantMessage.cost += usage.cost`, but
  `assistantMessage.tokens = usage.tokens`: **tokens are overwritten, not summed**. At the same
  time a `step-finish` part is written with the same `tokens`.
- Since v0.8.0 (14 September 2025), `streamText` runs with a single step (`stopWhen:
  stepCountIs(1)`; in the current version `stopWhen` is not given at all, and the AI SDK default
  is also 1 step), so normally **one assistant message = one API request = one step-finish**, and
  the message's `tokens` equal the step-finish's.
- **Before v0.8.0** (`stepCountIs(1000)` / a custom `stopWhen`) one message could contain several
  steps; there the message's `tokens` shows only **the last step**, and the correct number is the
  sum of the step-finish parts. step-finish parts have existed since v0.2.26 (10 July 2025); the
  older message format (v0.1.x-v0.2.25) (`metadata.assistant.tokens`) is different.
- OpenCode's own session total (`session.tokens_*`, `projector.ts` `applyUsage`) sums the
  step-finish parts, so OpenCode's own "request unit" is the step-finish too.
- If a step is cut off (abort, network error), no step-finish is written; the usage of that
  partial request exists nowhere locally.

**Consequence:** the step-finish part should be used as the per-request unit; if an assistant
message has no step-finish at all (for example before v0.2.26 or a half-finished record), fall
back to the message's own `tokens`. For one message the two must **not be summed together**: that
counts the same request twice.

## Field semantics: the history of `getUsage()`

All the numbers are derived by `Session.getUsage()` (`packages/opencode/src/session/session.ts`,
formerly `session/index.ts`) from the AI SDK / `@opencode-ai/llm` usage object. Over time this
function **changed meaning four times**; the same field names mean different things in different
versions:

| Period | Versions (date) | `tokens.input` | `tokens.output` | Note |
| --- | --- | --- | --- | --- |
| A | <= 1.0.61 (<= 12 November 2025), AI SDK 5 | The provider's raw `inputTokens`: **excludes cache** on Anthropic/Bedrock, **includes cache.read** on OpenAI/Gemini/OpenAI-compatible (OpenRouter, Copilot...) providers | Raw `outputTokens`: reasoning **included** on OpenAI/compatible and Anthropic, **excluded** on the Google (`@ai-sdk/google`) provider | `cache.write` only from the Anthropic/Bedrock metadata |
| B | 1.0.62 - 1.3.5 (13 November 2025 - 29 March 2026) | Raw if the providerMetadata has an `anthropic`/`bedrock` key, otherwise `input − cache.read (− cache.write, 1.1.37+)` → **excludes cache** | Same as period A (provider dependent) | 1.3.4-1.3.5 moved to AI SDK 6 but the conditional subtraction stayed, so on Anthropic input stayed **cache-inclusive** (a two-version bug). The `total` field exists from 1.1.57+ |
| C | 1.3.6 - 1.3.15 (29 March - 6 April 2026), AI SDK 6 | `input − cache.read − cache.write` for every provider → **excludes cache** | AI SDK 6 `outputTokens` → reasoning **included** | `reasoning` is also written separately |
| D | >= 1.3.16 (from 6 April 2026, 1.18.32 included) and v2 | **excludes cache** (non-cached) | `outputTokens − reasoningTokens` → reasoning **excluded** | Because Anthropic does not separate thinking, `reasoning = 0` there and thinking is inside `output` |

Period D is explicitly documented in the current `@opencode-ai/llm` `Usage` contract:
`inputTokens` is inclusive, `nonCachedInputTokens`/`cacheReadInputTokens`/`cacheWriteInputTokens`
are the parts, and `visibleOutputTokens = outputTokens − reasoningTokens`
(`packages/llm/src/schema/events.ts`). v2's `TokenUsage.total()` function sums
`input + output + reasoning + cache.read + cache.write`, which is the confirmation in the source
code that the five fields are **separate**. OpenCode's own `opencode stats` command also adds
`output + reasoning` per model (`packages/opencode/src/cli/cmd/stats.ts`).

The source of `cache.write` (D): `usage.cacheWriteInputTokens`, or
`providerMetadata.{anthropic,vertex}.cacheCreationInputTokens`,
`bedrock.usage.cacheWriteInputTokens`, `venice.usage.cacheCreationInputTokens`. The 5 minute /
1 hour TTL split is stored in no version.

The provider-dependent meaning in periods A/B was verified from the AI SDK 5 provider packages
(`ai@5.0.97`): Anthropic `inputTokens = input_tokens` (cache excluded), `outputTokens =
output_tokens`; OpenAI Chat `inputTokens = prompt_tokens` (cached included), `outputTokens =
completion_tokens` (reasoning included); Google `outputTokens = candidatesTokenCount`,
`reasoningTokens = thoughtsTokenCount` (separate); Bedrock `inputTokens` excludes cache. The code
comment in OpenCode v1.1.57 says the same explicitly ("Anthropic does it differently though -
inputTokens doesn't include cached tokens").

## Dedup

1. **The message id (`msg_…`)** is the primary key. As a record is updated, the same row/file is
   overwritten (`onConflictDoUpdate`), so no streaming copies appear. The JSON and SQLite copies
   and the copies migrated to v2 carry **the same id**; they can also be merged by id across
   different `opencode*.db` files.
2. **v1 fork copies are not caught by id.** `Session.fork` (`session.ts`) clones all messages and
   parts up to the chosen point into a new session with **new ids**; `tokens`, `cost`,
   `time.created`, `time.completed`, `providerID` and `modelID` are copied exactly (only `parentID`
   is remapped). The fork link is not kept in the new session either (`parent_id` is empty). If
   it is not deduplicated, the forked history is counted twice. The recommended content
   fingerprint (the same fields tokscale uses): `(time.created, time.completed, providerID,
   modelID, tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write,
   cost, agent)`. Two different real requests that match exactly on a millisecond timestamp, five
   counters and the cost are practically impossible; even so, fingerprint matching should be
   applied only to copies with **different ids**.
3. **v2 fork copies**: see `## The v2 line` (with the seq cut).
4. Within a message: step-finish parts are unique by their own `prt_…` ids; they are not summed
   with the message's `tokens` (see above).

## Sub-agent sessions, compaction, deletion

- **Sub-agents** (the `task` tool) open a separate session: `session.parent_id` points to the
  parent session, and the sub-agent's messages are in the same `message` table under its own
  `session_id`. The assistant message in the parent that called the tool carries only its own LLM
  call; the parent message of a subtask started by a command keeps `tokens` at zero. So
  sub-agents are not double counted and no extra merging is needed: scanning all sessions is
  enough.
- **Compaction**: the summary message (`summary: true`) is a real LLM request and must be counted.
  "Prune" only marks old tool outputs with `time.compacted`; it deletes no message/step.
- **Title generation** (`ensureTitle` with a small model) is not written to any message/part in
  v1, so these requests are **invisible** locally and cannot be counted.
- **Deletion**: when the user deletes a session (TUI, `opencode session`, the HTTP API, workspace
  removal), the messages and parts are deleted by cascade. When a new prompt is sent after
  `/undo`-revert (`SessionRevert.cleanup`), the reverted messages are deleted too, so requests
  that were really made disappear. There is no automatic age-based cleanup/retention code. That
  is why tokengraph's existing max-merge rule (in the ledger, and against the machine's own file
  in the data gist) is also needed for OpenCode.

## The `cost` field

OpenCode computes the cost for each step itself and writes it to the message **by summing**
(`cost += usage.cost`), and writes the step's own cost to the step-finish. The calculation:
models.dev prices (the local catalogue at the time of the request) ×
`input`, `output`, `cache.read`, `cache.write`, and `reasoning` also at the **output price**
(marked "TODO" in the code); the over-200K / context-tier price is chosen according to `tokens`;
on GitHub Copilot the `totalNanoAiu` reported by the provider is used. For custom/local models
(for example Ollama) it is usually `0`. In period C, reasoning was both inside `output` and
priced separately, so the cost was inflated. tokengraph must not use this field; the cost is
always computed from our own `pricing.ts`.

## Model naming

- A v1 assistant message: top-level `providerID` + `modelID` (on a user message,
  `model: {providerID, modelID, variant}`). v2: `model: {providerID, id, variant}`.
- The identifiers come from the [models.dev](https://models.dev) catalogue; the same model is written
  differently per provider (models.dev `api.json`, 27 September 2026):

| providerID | Example modelID |
| --- | --- |
| `anthropic` | `claude-sonnet-4-5`, `claude-opus-4-5-20251101`, `claude-opus-5-5` |
| `opencode` (Zen) | `claude-haiku-4-5`, `gpt-5.4`, `gpt-5.1-codex` |
| `github-copilot` | `claude-haiku-4.5`, `claude-opus-4.7`, `gpt-5.4` |
| `openrouter` | `anthropic/claude-opus-4.5`, `anthropic/claude-haiku-4.5` |
| `amazon-bedrock` | `us.anthropic.claude-opus-4-7`, `global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `google-vertex-anthropic` | `claude-sonnet-4-5@20250929`, `claude-opus-4-8@default` |
| `openai` | `gpt-5.4`, `gpt-5.3-codex` |
| `ollama`, custom providers | the free name the user gave in the config (for example `qwen3-coder:30b`) |

- `variant` (for example `default`, `high`) is the choice of reasoning level; fast mode / service
  tier information is **not stored**.
- Recommendation for mapping to a canonical name: keep the `providerID` separately (as source
  information), strip the known provider decorations from the `modelID` with explicit rules (for
  `openrouter` the vendor prefix such as `anthropic/`; for `amazon-bedrock` the region prefix
  `us.`/`eu.`/`global.`/`jp.`, the `anthropic.` prefix and the `-v1:0` suffix; for
  `google-vertex-anthropic` the `@date`/`@default` suffix), then put Claude ids through the same
  rule as `normalizeCursorModel` (dotted version → dashed, `claude-<family>-<version>`).
  Unrecognised ids must stay as they are, with no guessing.

## Mapping to tokengraph fields

The request unit: the step-finish part (or the message's own `tokens` if there is none). The
date: the local day from the `time.created` (ms epoch; the same as `message.time_created` in
SQLite) of the assistant message it belongs to, according to the project's `dateKey` behaviour.
The step-finish has no timestamp of its own in the JSON; in SQLite `part.time_created` is the
event time and can be a few seconds after the message's, so for consistency at the day boundary
the message time should be used.

**Period D (>= 1.3.16) and v2: current data:**

| OpenCode field | tokengraph field |
| --- | --- |
| `tokens.input` | `inputTokens` |
| `tokens.output + tokens.reasoning` | `outputTokens` |
| `tokens.cache.write` | `cacheCreationTokens` |
| `tokens.cache.read` | `cacheReadTokens` |
| no TTL split | `cacheCreation5mTokens`, `cacheCreation1hTokens`: `null` |

Reasoning: in D the five fields are separate (`TokenUsage.total` and the `Usage` contract in the
source code); since `input` already excludes cache, the cache is never subtracted from input
again; reasoning counts as output in our model (the same result as in the Codex adapter, where
`output_tokens` already includes reasoning; on Anthropic `reasoning = 0` anyway). The weighted
total: `input + output + cache_creation + 0.1 × cache_read`.

Additional rules for **older periods** (the version comes from the session's `version` field:
SQLite `session.version`, JSON `storage/session/<projectID>/<sessionID>.json` → `version`):

- **C (1.3.6 - 1.3.15):** `outputTokens = tokens.output` (reasoning is already inside; adding it
  would double count). The rest is the same as D.
- **B (1.0.62 - 1.3.5):** `inputTokens = tokens.input`; `outputTokens = tokens.output`, with
  `+ tokens.reasoning` only on Google providers, which report reasoning separately in AI SDK 5.
  In Anthropic records from 1.3.4-1.3.5, input also includes cache (so `input − cache.read −
  cache.write` is needed).
- **A (<= 1.0.61):** on providers other than Anthropic/Bedrock,
  `inputTokens = tokens.input − tokens.cache.read`; the output rule is the same as B.

The provider-dependent rules in B and A require knowing which AI SDK package a `providerID` goes
to; for built-in providers this is clear from the source code, but for custom (config-defined)
providers it cannot be known. For records that have `tokens.total` (>= 1.1.57), this uncertainty
can be resolved with arithmetic: if `input + cache.read + cache.write + output == total`, output
includes reasoning; if `... + reasoning == total`, it does not. If neither holds, the record must
go to a diagnostic counter without guessing. Also, in every period, a computed value that is
negative must be clamped to 0 and counted.

`session.version` is the version that **created** the session; if an old session was continued
with a newer version, the later messages were written with the new semantics. So when the `total`
equality is available, it must be used before the version rule.

## The v2 line (`@opencode/cli` 2.0.x)

- The same `DATA/opencode.db`. Sessions are in the `session_v2` table (with the `fork_session_id`
  and `fork_boundary` columns), and messages are in the `session_message` table:
  `id, session_id, type, seq, time_created, time_updated, data`.
- The `data` of a `type = 'assistant'` row (`packages/schema/src/session-message.ts`): `agent`,
  `model: {providerID, id, variant}`, `content[]`, `finish`, `cost`,
  `tokens: {input, output, reasoning, cache: {read, write}}` (optional),
  `time: {created, streamed?, completed?}` (ms). Each step is its own assistant message;
  `session.step.ended` writes the tokens (`SessionUsage.tokens`: `nonCachedInputTokens`,
  `visibleOutputTokens`, `reasoningTokens`, cache read/write), which is period D semantics.
  There is no step-finish part.
- The rows with `type = 'compaction'`, `status = 'completed'` also carry the
  `tokens`/`cost`/`model` of their own requests, and must be counted.
- The usage of title generation is not written to any message; it is only added to the
  `session_v2.tokens_*` counters (`UsageRecorded`, `source: "title"`), so there is no model/day
  breakdown.
- **The v1 migration**: on first start, v2 copies each v1 session into `session_v2` and its
  messages into `session_message`; **the message ids are kept**, the tokens are taken from the v1
  message's own `tokens`, and the v1 tables are not deleted. If the same id is in both tables, the
  v1 record (with the step-finish total) should be preferred.
- **Fork**: a v2 fork copies the parent's rows up to the boundary point with **new ids**
  (`<forkEventId>_<seq>`) but with the same `seq` and the same `data`. The copies are the rows in
  the fork session with `seq <= cut`: the cut is the `seq` of the boundary message in the parent if
  `fork_boundary.type = "through"`, or the largest `seq` in the parent smaller than that `seq` if
  `"before"`. If the cut cannot be resolved, the rows must not be dropped (the same stance as
  ccusage).

## Existing third-party parsers (cross-check)

- **ccusage** (`rust/adapters/opencode/`, commit `32ef434`): `$OPENCODE_DATA_DIR` (ccusage's own
  variable, not OpenCode's) or `$XDG_DATA_HOME/opencode` / `~/.local/share/opencode`;
  `opencode.db` and `opencode-<channel>.db`; the `message` table + v2 `session_message` + the old
  `storage/message/*/*.json`; dedup by message id; drops v2 fork copies using the `seq` cut; as a
  last resort uses the `session`/`session_v2` totals. It reads the **message-level `tokens`** (not
  the step-finish), takes `input` as it is, and puts reasoning into an "extra" total, not into
  output; it does not deduplicate v1 fork clones.
- **tokscale** (`crates/tokscale-core/src/sessions/opencode*.rs`, commit `1d9a939`): the same
  locations and tables; message-level `tokens`; keeps `input`/`output`/`reasoning`/cache
  separate; merges v1 fork clones with the fingerprint `created, completed, model, provider,
  tokens, cost, agent` (unless the ids conflict).
- Neither tool applies the period history (A-D); both accept the raw fields with the same meaning
  in all versions. For >= 1.3.16 data this note reaches the same result as they do; for older
  data it arrives at a more careful rule.

## Implementation notes

- A new source must be added to `packages/core/src/sources.ts` (for example `opencode`), or the
  ledger rejects its usage.
- Reading SQLite is necessary. The CLI requires Node 22, and reading OpenCode's database needs
  Node 22.13 or newer, where the built-in `node:sqlite` works without a flag. The adapter uses it,
  so there is no native dependency.
- Only the counter and identity fields should be read (with `json_extract`); `content`, text,
  tool output and file paths (`path.cwd/root`, `session.directory`) must not be stored or
  published.
- Pricing tier: the Anthropic long-context threshold can be computed per request (per step-finish)
  from `input + cache.read + cache.write`; there is no fast mode information, so no tier other
  than `standard`/`long-context` can be assigned.

## Not verified

- Only OpenCode 1.19.3 has produced a real `opencode.db` (in the fake-server run); **no JSON file of the
  pre-1.2 `storage/` layout and no database of an older version was seen**. The example JSON was derived from
  the schema. The column names and JSON paths were taken from the
  Drizzle schema and the migration SQL in the source code.
- The provider-dependent rules in periods A/B (especially custom providers, OpenRouter's own AI
  SDK provider, and the possibility that cache was subtracted twice in period B because of the
  `vertex` metadata key of Vertex-Anthropic) were not tested with real data. The `total` equality
  method is logically sound but was not verified on real records.
- That in multi-step messages from before v0.8.0 the step-finish total is larger than the
  message's `tokens` was inferred from reading the code; it was not compared with real old data.
  The pre-v0.2.26 message format (`metadata.assistant.tokens`) and the `project/<slug>/storage/`
  layout were not examined; the adapter should skip them and write to a diagnostic counter.
- Whether the opt-in "native runtime" path in the current version produces several steps in one
  message was not settled (the default AI SDK path is one step). The step-finish-total rule gives
  the right result either way.
- That opening a database in WAL mode read-only while OpenCode is running works without problems
  on all platforms (especially Windows) was not tested.
- In v2, the usage of a failed step attempt seems to be overwritten on retry (it remains only in
  the `session_v2` counters); not verified.
- The user base of the v2 line and scenarios of concurrent writes to the same database as v1 were
  not observed.
- The real API usage of title generation (v1 and v2) and of steps that were cut off is not
  recorded locally at all; this part is always undercounted. The end-to-end check confirmed it for title
  generation on 1.19.3: the server saw the title request and no row in the database carries it.

## Roots tokengraph scans

Every root below is read together with the default one and the ones remembered in `config.json` (`agentRoots`); roots that reach the same real path are read once, and a missing root is skipped silently. Environment values are trimmed, an empty one is unset, a leading `~` is expanded, and a relative one is ignored. The resolver is `adapters/opencode/roots.ts`.

- Roots: `~/.local/share/opencode` on every OS (macOS and Windows included), and `$XDG_DATA_HOME/opencode` when `XDG_DATA_HOME` is a non-empty absolute path. Each root contributes every `opencode*.db` and the pre-1.2 `storage/` tree.
- `$OPENCODE_DB` (not `:memory:`) names one more database: absolute as is, relative against the data folder, as OpenCode resolves it. Before multi-root discovery it replaced the folder scan; now it is added to it, because a run with the variable set and a run without it write different databases of one user. Messages deduplicate by id across databases, so a database reached twice only repeats work (and a database path is read once by real path).

## Sources

The source code links point to fixed commits: v1.18.32 =
`545f51d26cc39a907d2867492d498d9607ea5fa4`, v2.0.18 =
`cd9a14a6b688d4021bee381dfd39d2cef9c0f862`.

- [Data directory (v1 `global.ts`)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/global.ts#L11): `xdgData/opencode`.
- [Database path (v1 `database.ts#path`)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/database/database.ts#L43): `OPENCODE_DB`, the channel-based file name.
- [v1 table schema (`session/sql.ts`)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/session/sql.ts#L22): `session`, `message`, `part`.
- [Assistant / StepFinishPart schema](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/schema/src/v1/session.ts#L240): `tokens`, `cost`, `time`, `providerID`, `modelID` ([Assistant, L453](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/schema/src/v1/session.ts#L453)).
- [`getUsage` (period D)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/session.ts#L338): input/output normalisation and cost.
- [step-finish handling (`processor.ts`)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/processor.ts#L435): `cost +=`, `tokens =`.
- [A new assistant message for every request (`prompt.ts`)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/prompt.ts#L489).
- [Session totals from step-finish (`projector.ts`)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/session/projector.ts#L35) and [subtracted when a message is deleted](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/session/projector.ts#L274).
- [v1 fork cloning (`Session.fork`)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/session.ts#L691).
- [Revert cleanup](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/revert.ts#L110).
- [The `@opencode-ai/llm` `Usage` contract](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/llm/src/schema/events.ts#L51) and [the AI SDK adapter](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/llm/ai-sdk.ts#L45).
- [`opencode stats` output + reasoning](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/cli/cmd/stats.ts#L199).
- Period transitions: [v1.0.0 raw `getUsage`](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/session/index.ts), [v1.0.62 `excludesCachedTokens`](https://github.com/anomalyco/opencode/blob/a7774115c504132393dfebc34f9c15c6a2880ad6/packages/opencode/src/session/index.ts#L382), [v1.1.57 `total` and the Anthropic comment](https://github.com/anomalyco/opencode/blob/edcfd562af6ea5fdc1ade9f46259a676d7663801/packages/opencode/src/session/index.ts), [v1.3.4 AI SDK 6](https://github.com/anomalyco/opencode/blob/f0a9075fdf4d2c93ca3e1b27b953a871b03846ce/package.json), [v1.3.6 unconditional subtraction](https://github.com/anomalyco/opencode/blob/e7f94f9b9a3bd8742330e4a7ba8573ac21042c01/packages/opencode/src/session/index.ts), [v1.3.16 `output − reasoning`](https://github.com/anomalyco/opencode/blob/342436dfc45062ef8383d356de24418a967eb512/packages/opencode/src/session/index.ts#L281).
- Single step: [v0.8.0 `stepCountIs(1)`](https://github.com/anomalyco/opencode/blob/4b30705c425ceb832b7c91940c6f4f0674e815aa/packages/opencode/src/session/prompt.ts#L272); multi step: [v0.3.0 `stepCountIs(1000)`](https://github.com/anomalyco/opencode/blob/53bb6b4c4f63d9336dfea1a76fe0f0f9c62b88e7/packages/opencode/src/session/index.ts).
- JSON → SQLite: [v1.2.0 `json-migration.ts`](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/storage/json-migration.ts), [the trigger](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/index.ts#L82), [its removal (commit ca2acc4f8)](https://github.com/anomalyco/opencode/commit/ca2acc4f8d551a8055f17ad31684c8639289a531).
- v2: [`database-path.ts`](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/cli/src/database-path.ts#L4), [`global-roots.ts`](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/util/src/global-roots.ts#L5), [`session_v2`/`session_message`](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/core/src/session/sql.ts#L23), [the Assistant schema](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/schema/src/session-message.ts#L212), [`SessionUsage.tokens`](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/core/src/session/usage.ts#L11), [`TokenUsage.total`](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/schema/src/token-usage.ts#L16), [`session.step.ended`](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/core/src/session/message-updater.ts#L262), [the fork copy](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/core/src/session/projector.ts#L209), [the v1 migration](https://github.com/anomalyco/opencode/blob/cd9a14a6b688d4021bee381dfd39d2cef9c0f862/packages/core/src/database/v1-migration.bun.ts#L424).
- Distribution: [npm `opencode-ai`](https://www.npmjs.com/package/opencode-ai) (latest 1.18.32), [npm `@opencode/cli`](https://www.npmjs.com/package/@opencode/cli) (latest 2.0.18), [GitHub releases](https://github.com/anomalyco/opencode/releases).
- Official documentation: [Troubleshooting → Storage](https://opencode.ai/docs/troubleshooting/), [CLI (`db`, `stats`)](https://opencode.ai/docs/cli/), [Providers](https://opencode.ai/docs/providers/), [models.dev](https://models.dev/api.json).
- AI SDK 5 provider usage fields (`ai@5.0.97`): [Anthropic](https://github.com/vercel/ai/blob/ai%405.0.97/packages/anthropic/src/anthropic-messages-language-model.ts), [OpenAI Chat](https://github.com/vercel/ai/blob/ai%405.0.97/packages/openai/src/chat/openai-chat-language-model.ts), [Google](https://github.com/vercel/ai/blob/ai%405.0.97/packages/google/src/google-generative-ai-language-model.ts), [Bedrock](https://github.com/vercel/ai/blob/ai%405.0.97/packages/amazon-bedrock/src/bedrock-chat-language-model.ts).
- Third party: [ccusage OpenCode adapter (`32ef434`)](https://github.com/ryoppippi/ccusage/tree/32ef4346fc9d0d757a544cef5a04975884e4b773/rust/adapters/opencode/src) (`paths.rs`, `loader.rs` (fork cut), `parser.rs`); [tokscale (`1d9a939`)](https://github.com/junhoyeo/tokscale/tree/1d9a9395418efc6952944b794097935d7d6fa1e8/crates/tokscale-core/src/sessions) (`opencode.rs`, `opencode_schema.rs` (fingerprint dedup)).

## Decision rule for old records

Question: is the `tokens.total` stored in records from before v1.3.16 enough to decide for sure
which interpretation of the five counters is the right one? Short answer: **largely yes, but with
two exceptions and one assumption.** `total` was **not** in every version the real, all-inclusive
total of a request: in 1.3.4-1.3.5 it counted the cache twice for the Anthropic class. Every
formula below was read from the source code (links at the end of the section); none was tested
with real data.

Notation: the stored fields are `I = tokens.input`, `O = tokens.output`, `R = tokens.reasoning`,
`CR = tokens.cache.read`, `CW = tokens.cache.write`, `T = tokens.total`. The real values are:
`f` (uncached input), `cr`, `cw`, `o` (visible output), `r` (reasoning). All of them are **per
step** (`getUsage` is called on every `finish-step` event; in >= v0.8.0, message = a single step).

### 1. The `tokens.total` formula, by version and provider class

Between 1.1.57 and 1.3.15 the body of `getUsage` changed only in 1.3.4, 1.3.6 and 1.3.12
(verified by comparing tags). "Class A" means the models whose npm package OpenCode binds to the
model is `@ai-sdk/anthropic`, `@ai-sdk/amazon-bedrock` or `@ai-sdk/google-vertex/anthropic`:
OpenCode computes `total` itself only for these three packages, and for the others it writes the
AI SDK's `totalTokens` as it is.

| Version range | AI SDK | Provider class | Meaning of the stored fields | `T` (in terms of the stored fields) | Is `T` the real total? |
| --- | --- | --- | --- | --- | --- |
| 1.1.57 - 1.3.3 | 5.0.124 | Class A | `I=f`, `O=o+thinking`, `R=0` | `I + O + CR + CW` (OpenCode computes) | Yes |
| 1.1.57 - 1.3.3 | 5 | OpenAI Chat/Responses, OpenAI-compatible (Copilot, Venice, Groq, xAI...), OpenRouter 1.5.4 | `I=f` (`input − CR − CW`), `O=o+r` (reasoning included), `R=r` | the provider's `total_tokens` / `input+output` = `I + CR + CW + O` | Yes (if the provider reports an inclusive `prompt_tokens`) |
| 1.1.57 - 1.3.3 | 5 | Google (`@ai-sdk/google`, Vertex Gemini) | `I=f`, `O=o` (thoughts **excluded**), `R=r` | `totalTokenCount` = `I + CR + O + R` (+ `toolUsePromptTokenCount` if present) | Yes (no match if there is a tool-use prompt) |
| 1.3.4 - 1.3.5 | 6.0.138 | Class A | `I = f + cr + cw` (**inclusive**, a bug), `O=o+thinking`, `R=0` | `I + O + CR + CW` = `f + 2cr + 2cw + o` | **No**: cache counted twice |
| 1.3.4 - 1.3.5 | 6 | Not class A (OpenAI, compatible, OpenRouter 2.3.3, Google) | `I=f`, `O` inclusive (`o+r`), `R=r` | AI SDK 6 `inputTokens.total + outputTokens.total` = `I + CR + CW + O` | Yes |
| 1.3.6 - 1.3.15 | 6 | All | `I = f` (subtracted for every provider), `O = o+r`, `R=r` (`R=0` for class A) | `I + CR + CW + O` | Yes |
| >= 1.3.16 (reference) | 6 / `@opencode-ai/llm` | All | `I=f`, `O=o`, `R=r` | `I + CR + CW + O + R` | Yes |

Notes:

- OpenCode itself acknowledges the 1.3.4-1.3.5 bug: the fix commit in 1.3.6 is "fix(session): fix
  token usage double-counting w/ anthropic & bedrock due to AI SDK v6 upgrade (#19758)". The
  cause: in AI SDK 6, `@ai-sdk/anthropic` and Bedrock return
  `inputTokens.total = input + cache_read + cache_write`, but OpenCode still did not subtract
  when it saw `providerMetadata.anthropic|bedrock`; `@ai-sdk/anthropic` v3 **always** puts the
  `anthropic` key in `providerMetadata`.
- In AI SDK 5 the `totalTokens` of `@ai-sdk/anthropic` and Bedrock is `input_tokens +
  output_tokens` (cache excluded, **not** the real total); that is why OpenCode computes its own
  total for class A. An SDK that produces the same "input excluding cache + output" total but is
  not one of these three packages (for example an Anthropic model through `vercel` /
  `@ai-sdk/gateway`) was not verified in 1.1.57-1.3.3 and must not be considered safe.
- In AI SDK 6, `totalTokens` is computed in the core for every provider as `inputTokens.total +
  outputTokens.total`; the provider converters (OpenAI Chat/Responses, OpenAI-compatible, Google,
  Bedrock, Anthropic, OpenRouter 2.3.3) give `inputTokens.total` with cache included and
  `outputTokens.total` with reasoning included.
- Between 1.1.57 and 1.3.x, `safe()` only turns non-finite values into 0 and **does not clamp
  negatives**; `total` never goes through `safe`, so if the provider gave no total there is no
  `total` key in the JSON.
- Provider-specific edge cases: because OpenCode does not read the cache write that OpenRouter
  2.3.3 reports from the metadata, those writes fall into `I` (the total stays consistent, the
  difference is invisible); Gemini's `toolUsePromptTokenCount` makes `T` larger and no candidate
  matches; if a provider API's own definition of `prompt_tokens`/`cached_tokens` is non-standard
  (for example it does not give the cache hit in `cached_tokens`), this cannot be told apart from
  OpenCode's data.

### 2. The deterministic rule

The four-candidate arithmetic rule proposed by the coordinator is **sound** as long as `T` is the
real total: the implied totals of the four candidates are `nn = I+CR+CW+O+R`, `ny = I+CR+CW+O`,
`yn = I+O+R`, `yy = I+O` (the first letter is "does input include cache", the second "does output
include reasoning"). If the correct candidate is `ny`, `nn` matches only when `R=0` (the same
numbers), `yy` only when `CR+CW=0` (the same numbers), and `yn` when `R = CR+CW` (different
numbers → a contradiction → skip). If the correct candidate is `nn`, the other three match only
when the numbers are the same. So selecting a wrong interpretation **on its own** is impossible.
In two cases `T` is not the real total and the rule selects wrongly; these must be excluded
separately.

The rule (for each step-finish part, or for the message's `tokens` if there is none):

1. **Basic validation.** `I, O, R, CR, CW` must be finite integers and >= 0; otherwise skip.
2. **If there is no `total`** (<= 1.1.56 or a provider that gives no total): it is certain only
   if `CR = CW = R = 0` → `(input=I, output=O, cacheWrite=0, cacheRead=0)`; skip in every other
   case. (Up to 1.0.61, `I` included cache on providers other than Anthropic/Bedrock and `O` on
   Google excluded reasoning; without `total` these need the version and npm information, and
   npm is not stored.)
3. **If there is a `total`:** compute the candidates; eliminate a candidate that has a negative
   component (`fresh = I − CR − CW < 0` or `visible = O − R < 0`); keep the ones whose implied
   total equals `T` exactly.
   - If no candidate remains, or the remaining ones disagree on the four numbers → skip.
   - If `CR + CW > 0` and all the remaining candidates are from the "input includes cache"
     (`y*`) family → skip. In no reliable version/provider combination is `y*` the right
     interpretation; it arises only on unverified paths (a non-class-A npm package carrying an
     `anthropic`/`bedrock` metadata key, for example a gateway), and there the meaning of `T` is
     uncertain.
   - The result is always `n*`: `inputTokens = I`, `cacheReadTokens = CR`,
     `cacheCreationTokens = CW`, `outputTokens = O + R` (`nn`) or `O` (`ny`).
4. **Excluding class A in 1.3.4-1.3.5.** If `CR + CW > 0` **and** `R = 0` **and** the record could
   have been written by 1.3.4/1.3.5 → skip. In this case `ny` matches but is wrong because `I`
   also includes cache; the arithmetic cannot tell this from a 1.3.3 or 1.3.6+ class A record
   (all three have `T = I+CR+CW+O`, `R = 0`). A record with `R > 0` cannot be class A (AI SDK 6
   reports no reasoning at all for class A), and if `CR+CW = 0` all the interpretations give the
   same number; these two are safe.
   The definition of "could have been written by 1.3.4/1.3.5":
   - `time.created >= 2026-03-27T20:24:30Z` (the moment the AI SDK 6 commit entered `dev`,
     `c33d999`; dev/beta builds may have run this code before the npm release, that is before
     29 March 01:01Z), **and**
   - unless this condition holds: `session.version` is >= 1.3.6 as semver **and**
     `message.time.created >= session.time_created`.
   If `session.version` cannot be resolved (`0.0.0-dev-…`, `local`, a snapshot), count it as
   "could have".
5. **No provider identity is needed.** The rule does not use `providerID`; deriving class A from
   `providerID` is not reliable anyway: the npm package is determined **per model** (models.dev,
   27 September 2026: of the `opencode` Zen provider's models, 22 use `@ai-sdk/anthropic`, 31
   use `@ai-sdk/openai`, 51 use `@ai-sdk/openai-compatible` and 8 use `@ai-sdk/google`; `zenmux`,
   `opencode-go` and `minimax*` also use the Anthropic package), and the catalogue changes over
   time; users can also assign any npm package to custom providers. So unknown/custom providers
   are handled exactly with the steps above.

In brief, the safe subsets are: (a) every record with `CR+CW = 0` and `R = 0`; (b) records that
have `total`, whose arithmetic resolves uniquely to `n*`, and that carry no 1.3.4-1.3.5 risk;
(c) records with `R > 0` whose arithmetic resolves uniquely. What is skipped: <= 1.1.56 records
that have no `total` and carry cache/reasoning, cached `R = 0` records in the 1.3.4-1.3.5 window,
`y*`-only matches, and non-matches.

The assumptions the rule rests on (the certainty depends on them):

- **No downgrades:** the messages in a session were not written with a version older than the one
  that created the session. If the user downgraded OpenCode and continued the same session, step
  4 can be wrong. Recognising >= 1.3.16 records as period D rests on the same assumption, because
  D and a 1.3.4-1.3.5 class A record look the same in the arithmetic.
- The provider's own `total_tokens`/`prompt_tokens` are consistent with its own definition.
- The machine clock is roughly right (`time.created` is the local `Date.now()`).

### 3. Which version field?

- There is **no version field** on the message or the part (not in the `Assistant` and
  `StepFinishPart` schemas). The only version information is `session.version` (the SQLite
  column; in JSON, `storage/session/<projectID>/<sessionID>.json` → `version`).
- `session.version` is written **only when the session is created** (`createNext`:
  `version: Installation.VERSION`; this is the only place of assignment in 1.1.57, 1.3.12 and
  1.18.32). Session updates write the stored `info.version` back as it is (`projector.ts`
  `sessionRow`, formerly `projectors.ts` `toPartialRow`); it is **not updated** when an old
  session is continued. So for the version that wrote a message, `session.version` is only a
  **lower bound**.
- The exception: in a v1 fork, the new session is created by the version that made the fork, but
  the cloned messages carry the original `time.created`. So the lower bound should be applied only
  to messages with `message.time.created >= session.time_created`; messages timed earlier than
  that are clones, and the session's version says nothing about them.
- npm publish times can be used as an upper bound (1.3.4: 2026-03-29T01:01:37Z, 1.3.6:
  2026-03-29T18:03:03Z, 1.3.16: 2026-04-06T03:45:39Z), but the dev/beta channels run the code
  before the release; the safe lower bound is the time the commit entered `dev`.

### Sources (this section)

- `getUsage` versions: [1.1.57 `total` iife, L475](https://github.com/anomalyco/opencode/blob/edcfd562af6ea5fdc1ade9f46259a676d7663801/packages/opencode/src/session/index.ts#L475); [1.3.4 conditional subtraction L272 and `total` L277](https://github.com/anomalyco/opencode/blob/f0a9075fdf4d2c93ca3e1b27b953a871b03846ce/packages/opencode/src/session/index.ts#L272); [1.3.6 `total = usage.totalTokens`, L272](https://github.com/anomalyco/opencode/blob/e7f94f9b9a3bd8742330e4a7ba8573ac21042c01/packages/opencode/src/session/index.ts#L272); [1.3.12 vertex cache-write, L262](https://github.com/anomalyco/opencode/blob/892bdebaacbed3fc76976431c7aa7b81ab639fb6/packages/opencode/src/session/index.ts#L262); [1.3.16 `output − reasoning`](https://github.com/anomalyco/opencode/blob/342436dfc45062ef8383d356de24418a967eb512/packages/opencode/src/session/index.ts#L281).
- Commits: [AI SDK 6 (`c33d999`, #18433)](https://github.com/anomalyco/opencode/commit/c33d9996f0e630d15b6e40b9a1feb578e991561a); [the double-count fix (`72c77d0`, #19758)](https://github.com/anomalyco/opencode/commit/72c77d0e7b488dd1c0c62287b56623915b469506); [vertex-anthropic cache (`26cc924`, #20266)](https://github.com/anomalyco/opencode/commit/26cc924ea223cb27449b432beddb8abcfc36e65b).
- Pinned package versions: [1.1.57 `packages/opencode/package.json`](https://github.com/anomalyco/opencode/blob/edcfd562af6ea5fdc1ade9f46259a676d7663801/packages/opencode/package.json) (`@ai-sdk/anthropic` 2.0.58, `openai` 2.0.89, `google` 2.0.52, `amazon-bedrock` 3.0.74, `openai-compatible` 1.0.32, `@openrouter/ai-sdk-provider` 1.5.4; `ai` 5.0.124); [1.3.4](https://github.com/anomalyco/opencode/blob/f0a9075fdf4d2c93ca3e1b27b953a871b03846ce/packages/opencode/package.json) (`anthropic` 3.0.64, `openai` 3.0.48, `google` 3.0.53, `amazon-bedrock` 4.0.83, `openai-compatible` 2.0.37, OpenRouter 2.3.3; `ai` 6.0.138).
- AI SDK 5: [Anthropic streaming `totalTokens = input + output` (around L1349)](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%402.0.58/packages/anthropic/src/anthropic-messages-language-model.ts#L1349); [Bedrock (L590)](https://github.com/vercel/ai/blob/%40ai-sdk/amazon-bedrock%403.0.74/packages/amazon-bedrock/src/bedrock-chat-language-model.ts#L590); [OpenAI Chat `total_tokens` (L512)](https://github.com/vercel/ai/blob/%40ai-sdk/openai%402.0.89/packages/openai/src/chat/openai-chat-language-model.ts#L512); [Google `totalTokenCount` (L396)](https://github.com/vercel/ai/blob/%40ai-sdk/google%402.0.52/packages/google/src/google-generative-ai-language-model.ts#L396).
- AI SDK 6: [core `totalTokens = input.total + output.total` (L106)](https://github.com/vercel/ai/blob/ai%406.0.138/packages/ai/src/types/usage.ts#L106); [Anthropic `inputTokens.total` includes cache (L61)](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.64/packages/anthropic/src/convert-anthropic-messages-usage.ts#L61); [Bedrock](https://github.com/vercel/ai/blob/%40ai-sdk/amazon-bedrock%404.0.83/packages/amazon-bedrock/src/convert-bedrock-usage.ts); [OpenAI Chat](https://github.com/vercel/ai/blob/%40ai-sdk/openai%403.0.48/packages/openai/src/chat/convert-openai-chat-usage.ts); [OpenAI Responses](https://github.com/vercel/ai/blob/%40ai-sdk/openai%403.0.48/packages/openai/src/responses/convert-openai-responses-usage.ts); [OpenAI-compatible](https://github.com/vercel/ai/blob/%40ai-sdk/openai-compatible%402.0.37/packages/openai-compatible/src/chat/convert-openai-compatible-chat-usage.ts); [Google `outputTokens.total = candidates + thoughts` (L45)](https://github.com/vercel/ai/blob/%40ai-sdk/google%403.0.53/packages/google/src/convert-google-generative-ai-usage.ts#L45).
- The OpenRouter provider: npm tarballs [`@openrouter/ai-sdk-provider@1.5.4`](https://www.npmjs.com/package/@openrouter/ai-sdk-provider/v/1.5.4) and [`@2.3.3`](https://www.npmjs.com/package/@openrouter/ai-sdk-provider/v/2.3.3), `dist/index.mjs` (`totalTokens = prompt_tokens + completion_tokens`; `inputTokens.cacheWrite` in 2.3.3).
- The Copilot SDK (in the repo): [1.1.57 `copilot/chat/openai-compatible-chat-language-model.ts`](https://github.com/anomalyco/opencode/blob/edcfd562af6ea5fdc1ade9f46259a676d7663801/packages/opencode/src/provider/sdk/copilot/chat/openai-compatible-chat-language-model.ts) (`totalTokens = total_tokens`).
- The version field: [1.1.57 `version: Installation.VERSION` (L218)](https://github.com/anomalyco/opencode/blob/edcfd562af6ea5fdc1ade9f46259a676d7663801/packages/opencode/src/session/index.ts#L218); [1.18.32 `createNext` (L515)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/session.ts#L515); [fork `createNext` (L694)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/session.ts#L694); [`sessionRow` writes the stored version (L55)](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/session/projector.ts#L55).
- npm publish times: [registry.npmjs.org/opencode-ai](https://registry.npmjs.org/opencode-ai) (the `time` field).
