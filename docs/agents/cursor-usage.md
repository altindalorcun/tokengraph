# Cursor local token usage data

This note explains where, in Cursor IDE's local files, you can find out which LLM used how many
tokens. Unlike Codex CLI, Cursor's local records are not documented as **a single primary JSONL
stream**; the token counts are spread over several different SQLite tables, hook events and
(partly) the context meter. tokengraph's Cursor adapter reads none of these SQLite sources. It
collects the event file written by its own `stop` hook and, optionally, rows imported from a dashboard CSV; see "tokengraph integration" below.
The adapter code is in `packages/cli/src/adapters/cursor/`, and it is installed with
`tokengraph install-hook --agent cursor`. The rest of the document (the SQLite schema, the bubble
and context meter read paths) remains as a discovery note and a reference for manual analysis, for
the sources the adapter **does not use**.

The counters here are local session / context-window indicators; they are not Cursor's
[billing dashboard](https://cursor.com/settings) or an Enterprise Admin API report. tokengraph's purpose is to show
daily token usage, not to calculate a bill.

## tokengraph integration

The adapter is **hook-based only**: none of the SQLite sources below is read, because none of
them gives a reliable token counter (see "Not verified" and the sections below it). The only
record source is the event file written by the `stop` hook; since Cursor keeps this data nowhere
else, **the file is never pruned**.

### Installation

```bash
node packages/cli/dist/bin.js install-hook --agent cursor
```

This adds the `tokengraph cursor-hook` command to `~/.cursor/hooks.json` (in the shape
`{version: 1, hooks: {stop: [{command}]}}`, keeping existing hooks;
`packages/cli/src/cursor-hooks-json.ts`). Cursor has to be restarted.
**Usage counts only from the moment the hook is installed**: Cursor has no usable counter for
past turns, so earlier usage cannot be recovered.

### The `cursor-hook` command (`packages/cli/src/commands/cursor-hook.ts`)

Each time a Cursor agent turn ends, Cursor calls the `stop` hook with a JSON payload on stdin and
expects JSON on stdout. `afterAgentResponse` is not used: that hook also carries the assistant's
**text**, which conflicts with the storage rule (see below).

- It waits for stdin for at most 3 seconds (`STDIN_TIMEOUT_MS`); if the command is run by hand
  from a terminal (TTY) it returns immediately with an empty result.
- It extracts only the allowed fields (the table below); stored string fields are cut to 200
  characters, and if `generation_id` is longer than 200 characters the event is rejected entirely
  (not parsed). The model name (`model`/`model_id`) is additionally cut to 120 characters at
  aggregation time, to match the ledger's limit; see "Aggregation" below.
- It appends the event to `$TOKENGRAPH_HOME/cursor-events.jsonl` (default
  `~/.tokengraph/cursor-events.jsonl`, file mode `0600`).
- **It only records, and never publishes.** The hook never triggers a `sync` (no background sync,
  no throttle, no stamp file); publishing happens only when the user runs `tokengraph sync`, just
  like Claude Code and Codex (for example once by hand at the end of the day, or through the hook
  that `install-hook` installs on the Claude Code side).
- **It never throws and never exits with a non-zero code**: under every condition it writes `{}`
  to stdout and returns `0`. Cursor hooks are fail-open; a broken hook must not interrupt the
  user's session.

### Stored fields

Each line in the event file (`cursor-events.jsonl`) contains only the following fields. No other
field in the hook payload, such as `conversation_id`, `transcript_path`, `workspace_roots`,
`user_email` or the assistant/user **text**, is **ever stored**:

| Field | Source | Note |
| --- | --- | --- |
| `receivedAt` | The moment the hook ran | The payload has no timestamp; the hook stamps it itself |
| `generationId` | `generation_id` | The dedup key |
| `model` / `modelId` | `model` / `model_id` | Cut to 200 characters |
| `fast` | An item in `model_params` | Boolean; accepted shapes: `{id:"fast", value:true}`, `{id:"fast", value:"true"}`, `{name:"fast", value:true}`, `{name:"fast", value:"true"}` (if there is no `id`, `name` is used); if the model name does not already end with `-fast`, it is appended to the name |
| `status` | `status` | Cut to 200 characters |
| `cursorVersion` | `cursor_version` | Cut to 200 characters |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | hook fields of the same name | Numeric; `null` = it was not in the payload (unknown, not zero) |

Source: `packages/cli/src/adapters/cursor/events.ts`.

### Aggregation (`sync`, `packages/cli/src/adapters/cursor/aggregator.ts`)

- **Dedup by `generationId`** (per-field max): if `stop` fires several times for the same turn,
  it is not counted twice.
- If `inputTokens` or `outputTokens` is missing (these fields are not officially documented, so
  some versions/turns may not send them), that turn is **not counted as zero but skipped
  entirely**; the note "N Cursor turn(s) reported no token counts and were skipped" appears in
  the `sync` output.
- Clean input = `max(0, input_tokens − cache_read_tokens − cache_write_tokens)`, because
  Cursor's `input_tokens` includes cache reads/writes. If it comes out negative it is clamped to
  0 and the note "N turn(s) reported more cached than total input; counted as 0 fresh input" is
  added.
- Cursor has no 5 min / 1 h cache split, so it is always `null` (never `0`).
- Model name: `modelId ?? model ?? 'unknown'`, first normalised with `normalizeCursorModel` (see
  "Model names" below); see `cursorModelIdentity`. Because the ledger limits model names to 120
  characters (`packages/core/src/schemas.ts`), `capModelName` always cuts the result so it does
  not exceed `MAX_MODEL_NAME_LENGTH` (120) characters: the base name is cut first, so even with
  the `-fast` suffix the total stays within 120.
- **Pricing tier:** Composer Fast carries its own model name (`composer-2.5-fast`), so it always
  stays in the `standard` tier. If another model has the `fast` flag, the model name **does not
  change** (so that it merges with that model's other usage); only the pricing tier becomes
  `fast`. Cursor has no long-context/fast-long-context tier split; only `standard` and `fast`
  are used.
- Day: the local date of `receivedAt` (the same `--timezone` mechanism as the other adapters).

### CSV import (`tokengraph import cursor <file.csv>`)

Cursor's dashboard (Usage, then export CSV) produces a usage CSV that covers the time before the
hook existed. The user downloads it and passes the path; tokengraph reads no Cursor login and calls no
Cursor API. Code: `adapters/cursor/{csv,imports}.ts`, `commands/import.ts`.

**Not verified against a real export.** The format below comes from the open-source TokenTracker
parser (`src/lib/cursor-config.js`) and descriptions of the dashboard export; no real file was
available. Columns are found by header name, in any order, so extra or reordered columns are fine.

| Column | Use |
| --- | --- |
| `Date` | Required. An ISO date or date-time. **A Date without a time zone is read as UTC**; one with `Z` or an offset is converted. Any other shape counts as malformed. |
| `Model` | Required. Normalised like hook events (`normalizeCursorModel`, `cursorModelIdentity`), including a `fast` word in the slug. Stored as written; normalised when read. |
| `Input (w/o Cache Write)` | Required. `inputTokens`. |
| `Input (w/ Cache Write)` | Required. `cacheCreationTokens = max(0, w/ - w/o)`. |
| `Cache Read` | Required. `cacheReadTokens`. |
| `Output Tokens` | Required. `outputTokens`. |
| `Max Mode` | Optional. Stored as `maxMode`, **not** a pricing tier: Max Mode widens the context window, and this adapter has no long-context tier (only `standard` and `fast`). Mapping it to a tier would invent a rate. |
| `Kind`, `Total Tokens`, `Cost` | Ignored. |

The 5m/1h cache-write split is `null`. Parsing is RFC 4180 (quoted fields, `""` escapes, CRLF, newlines
inside quotes); a leading BOM is skipped; numbers may be quoted and contain thousands separators
(`"1,234"`). A file with none of the required columns is rejected as "not a Cursor usage export", a file
missing some names them; in both cases nothing is written. A row whose date or required count does not
parse is skipped as malformed; a row whose counts are all zero (errored, not charged) is skipped as zero.

**Storage:** `$TOKENGRAPH_HOME/cursor-import.jsonl` (mode 0600, **never pruned**, like the event file).
One line per row: `{id, at, model, maxMode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`
(`inputTokens` is fresh input). `id` is the SHA-256 of the row's parsed fields (ISO `at`, model, max
mode, the four counts) plus its occurrence index among identical rows of that CSV in file order, so
re-importing the same or an overlapping export adds nothing twice, while two genuinely identical
requests stay two rows.

**Overlap with the hook:** the adapter reads both files. An imported row counts only when its `at` is
strictly before the earliest hook event in `cursor-events.jsonl` (all rows when there is none), at every
collect, not only at import time. The two sets are disjoint, so they are summed, not max-merged. The
command reports rows it skipped for being at or after the hook start and does not store them.

**Ledger:** after storing, the command takes the sync lock and merges the Cursor adapter's result into
the ledger, as `sync --local` does for Cursor only, reading back to two days before the oldest row. It
never publishes; when logged in it ends with "Run `tokengraph sync` to publish."

Import on one machine only: machines are added together, so importing the same file on two machines
counts it twice.

### Model names

Cursor names Anthropic models in its own format (`claude-4.5-opus-high-thinking`,
`claude-opus-4.6`), while Anthropic's API and Claude Code call the same model `claude-opus-4-5`.
`normalizeCursorModel` (`packages/cli/src/adapters/cursor/aggregator.ts`) turns Cursor's Claude
slugs into Anthropic's canonical id with these rules, so that the same model's usage through
Cursor adds up with its usage in other tools:

- **Thinking/effort/mode words are dropped**: words such as `thinking`, `high` and `max` count as
  variants of the same model: `claude-4.5-opus-high-thinking` → `claude-opus-4-5`,
  `claude-4.6-sonnet-medium-thinking` → `claude-sonnet-4-6`.
- **Claude 3.x keeps Anthropic's old version-first naming** (like `claude-3-7-sonnet`); 4.x and
  later are turned into the family-first form (`claude-opus-4-8`, `claude-sonnet-4-6`); an id
  that already arrives in canonical form is left as it is.
- A Claude id whose family or version cannot be resolved, or that carries an unexpected character
  (for example an `@20251101` date suffix), is left **as it is, without guessing**, because a
  wrong mapping can merge two different models under one name.
- Non-Claude ids (`gpt-*`, `gemini-*`, `composer-2.5`, `default`, ...) pass **untouched**.
- **Composer Fast keeps its own model name** (`composer-2.5-fast`): the Fast variant of Composer
  has its own published price, so it stays a separate model (see "Pricing" below).
- **For any other model, Fast is modelled not as a separate model name but as the `fast` pricing
  tier under the same model**, so that the model's tokens are added up on the same row as
  Cursor's normal (standard) usage; only the cost stays unknown unless a fast rate exists (see
  the "Pricing tier" item above).

## Local data location

Because Cursor is a VS Code derivative, it keeps its data under two roots: the IDE state
(`Application Support` / `config`) and the agent home directory (`~/.cursor`).

| Source | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Global state (primary) | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | `~/.config/Cursor/User/globalStorage/state.vscdb` | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |
| Workspace state (old / complementary) | `…/User/workspaceStorage/<hash>/state.vscdb` | same structure | same structure |
| Agent home directory | `~/.cursor/` | `~/.cursor/` | `%USERPROFILE%\.cursor\` |
| Agent transcripts | `~/.cursor/projects/<workspace-slug>/agent-transcripts/<conversation-id>/<id>.jsonl` | same | same |
| AI code tracking | `~/.cursor/ai-tracking/ai-code-tracking.db` | same | same |
| Agent chat store (new CLI) | `~/.cursor/chats/<workspace-hash>/<chat-id>/store.db` | same | same |

Environment variables:

- **`CURSOR_AGENT_HOME`**: replaces `~/.cursor` (transcripts, tracking, chats).
- **`CURSOR_CONFIG_DIR`**: changes the CLI transcript root (does not affect the IDE state).

SQLite files write a WAL (`state.vscdb-wal`) while Cursor is open. For live reading prefer
`mode=ro`; copying the file and opening it offline is also safe. `immutable=1` skips the WAL and
can give an incomplete / old view.

```bash
CURSOR_STATE="${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb"

# Number of Composer sessions
sqlite3 "file:${CURSOR_STATE}?mode=ro" \
  "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';"

# Number of bubble (message) rows
sqlite3 "file:${CURSOR_STATE}?mode=ro" \
  "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';"
```

Authentication, OAuth tokens and `Cookies` files are not needed for usage analysis and **must not
be read**.

## The SQLite schema (`state.vscdb`)

Three tables matter in the global state:

| Table | Role |
| --- | --- |
| `cursorDiskKV` | Composer metadata, bubbles, AgentKv, request context |
| `ItemTable` | VS Code key-value store (in the workspace: `composer.composerData`, `aiService.generations`) |
| `composerHeaders` | Composer header index |

`cursorDiskKV` key prefixes:

| Key | Content |
| --- | --- |
| `composerData:<composerId>` | Session metadata: model, context meter, bubble order |
| `bubbleId:<composerId>:<bubbleId>` | One message / tool step |
| `agentKv:blob:<hash>` | Provider messages (model name, tool calls) |
| `messageRequestContext:<composerId>:<requestId>` | Attached files, diffs, terminal selection |

`composer.composerData` and `aiService.generations` in the workspace `state.vscdb` carry only
that workspace's composer list / a short generation summary; the full token detail is in the
global `cursorDiskKV` or in the hooks.

## Getting at token information (in priority order)

The answer to "how many tokens did each LLM burn?" in Cursor is not in a single file. The sources
below are listed in order of reliability.

### 1. Hooks: `stop` / `afterAgentResponse` (the most accurate local source)

Cursor hooks give **that turn's accumulated token counters** when an agent turn ends. The official
hooks documentation lists neither these token fields nor a timestamp; the token fields rest on a
Cursor employee's forum reply ([forum discussion](https://forum.cursor.com/t/how-to-obtain-token-usage-per-request/168317)).
The `afterAgentResponse` hook carries the same fields but also contains the **text** the
assistant produced; that is why tokengraph's adapter uses only `stop` (see "tokengraph
integration").

Example `stop` payload fields:

```json
{
  "hook_event_name": "stop",
  "conversation_id": "829fe048-75fc-4657-8fc6-c48c6080b5ef",
  "generation_id": "2314f762-5537-47fd-ae91-f9285a81b1e2",
  "model": "composer-2.5",
  "model_id": "composer-2.5",
  "input_tokens": 1180993,
  "output_tokens": 8146,
  "cache_read_tokens": 1007022,
  "cache_write_tokens": 173957
}
```

Rules:

- **`input_tokens`** also includes `cache_read_tokens` and `cache_write_tokens`. For pure "new
  input", subtract the cache values: `max(0, input - cache_read - cache_write)`.
- The numbers are **cumulative per turn**; for the same `generation_id`, `stop` and
  `afterAgentResponse` give the same values, so do not add the two together.
- The fields are **optional**; if they are missing, do not assume zero.
- They cover **only the parent agent's** turn; subagent tokens are not included. Subagents are
  billed as their own model calls; `subagentStop` gives duration and model but carries no token
  field.
- **`reasoning_tokens`** does not exist in hooks.

For a persistent usage ledger, installing a `stop` command hook in `~/.cursor/hooks.json` and
writing the JSON to an append-only file is the most reliable local method; tokengraph's Cursor
adapter does exactly this (see "tokengraph integration" above). For project-scoped hooks
`.cursor/hooks.json` can be used; tokengraph installs only the user-scoped `~/.cursor/hooks.json`.

### 2. Bubble `tokenCount` (`bubbleId::…` rows)

In each bubble's JSON:

```json
{
  "type": 2,
  "bubbleId": "c786961a-cddd-4c64-b1c6-0d1b413aedb9",
  "modelInfo": { "modelName": "gemini-3-pro" },
  "tokenCount": {
    "inputTokens": 31308,
    "outputTokens": 8498
  }
}
```

- **`type`**: `1` = user, `0` / `2` = assistant / tool variants.
- **`modelInfo.modelName`**: the model at bubble level (on assistant bubbles), but according to
  the observation below it is **missing** from bubbles whose `tokenCount` is filled in; the
  co-occurrence of `modelInfo` + `tokenCount` in the example JSON is a schema example and does not
  match the real rows observed on this machine.
- **On this machine (Cursor 3.14.7, September 2026), only 76 of 9,270 bubbles have a filled
  `tokenCount`**, all dated between 2025-11-19 and 2026-01-08; none of those 76 bubbles has
  `modelInfo`. The `usageData` / `tokenCount` in the composer metadata is **empty in all 268
  composers**. A Composer 2.5 Fast session run on the same day produced 95 bubbles, all
  `{inputTokens:0, outputTokens:0}`: the counting moved to the UI context meter
  ([tokenuse reverse-engineering note](https://tokenuse.app/docs/development/tools/cursor/)).
  That is why tokengraph's adapter does not consult the bubble/composer counters at all and
  trusts only the hook.

Listing non-zero bubbles:

```bash
sqlite3 "file:${CURSOR_STATE}?mode=ro" <<'SQL'
SELECT key,
       json_extract(value,'$.modelInfo.modelName') AS model,
       json_extract(value,'$.tokenCount.inputTokens') AS input,
       json_extract(value,'$.tokenCount.outputTokens') AS output
FROM cursorDiskKV
WHERE key LIKE 'bubbleId:%'
  AND (
    json_extract(value,'$.tokenCount.inputTokens') > 0
    OR json_extract(value,'$.tokenCount.outputTokens') > 0
  )
LIMIT 20;
SQL
```

Total per model (non-zero bubbles only):

```bash
python3 <<'PY'
import sqlite3, json
from collections import defaultdict

db = sqlite3.connect(f"file:{__import__('os').environ['HOME']}/Library/Application Support/Cursor/User/globalStorage/state.vscdb?mode=ro", uri=True)
composer_model = {}
for k,v in db.execute("SELECT key,value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"):
    cid = k.split(':',1)[1]
    try:
        composer_model[cid] = json.loads(v).get('modelConfig',{}).get('modelName','unknown')
    except: pass

totals = defaultdict(lambda: [0,0,0])
for k,v in db.execute("SELECT key,value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"):
    parts = k.split(':')
    cid = parts[1] if len(parts)>2 else ''
    try:
        d = json.loads(v)
        inp = (d.get('tokenCount') or {}).get('inputTokens') or 0
        out = (d.get('tokenCount') or {}).get('outputTokens') or 0
        if inp==0 and out==0: continue
        m = (d.get('modelInfo') or {}).get('modelName') or composer_model.get(cid,'unknown')
        totals[m][0]+=inp; totals[m][1]+=out; totals[m][2]+=1
    except: pass

for m,(i,o,n) in sorted(totals.items(), key=lambda x: x[1][0]+x[1][1], reverse=True):
    print(f"{m}\tinput={i:,}\toutput={o:,}\tbubbles={n}")
PY
```

### 3. Context meter: `composerData.promptTokenBreakdown`

A snapshot of the **input-side context window** in the composer metadata:

```json
{
  "composerId": "829fe048-75fc-4657-8fc6-c48c6080b5ef",
  "modelConfig": { "modelName": "composer-2.5", "maxMode": false },
  "contextTokensUsed": 78820,
  "promptTokenBreakdown": {
    "totalUsedTokens": 78820,
    "maxTokens": 200000,
    "categories": [
      { "id": "system_prompt", "estimatedTokens": 492 },
      { "id": "tools", "estimatedTokens": 8545 },
      { "id": "rules", "estimatedTokens": 5096 },
      { "id": "skills", "estimatedTokens": 3979 },
      { "id": "conversation", "estimatedTokens": 58588 }
    ]
  }
}
```

Important limits:

- This is **not a billed token total**; it is the last context snapshot.
- It **contains no output tokens**; it shows only the prompt / context load.
- It grows over the session; adding up all turns for a daily total **double counts**. For a
  session, at most the last snapshot or the hook-based turn records should be used.
- The categories (`system_prompt`, `tools`, `rules`, `skills`, `mcp`, `subagents`,
  `conversation`) are useful for cost attribution but are not an official billing breakdown.

Reading for a single composer:

```bash
COMPOSER_ID="829fe048-75fc-4657-8fc6-c48c6080b5ef"
sqlite3 "file:${CURSOR_STATE}?mode=ro" \
  "SELECT json_extract(value,'$.modelConfig.modelName'), json_extract(value,'$.promptTokenBreakdown.totalUsedTokens'), json_extract(value,'$.contextTokensUsed') FROM cursorDiskKV WHERE key='composerData:${COMPOSER_ID}';"
```

### 4. AgentKv: model name, no tokens

`agentKv:blob:<hash>` rows carry assistant messages in the Vercel AI SDK format. The model is
under `content[].providerOptions.cursor.modelName`:

```json
{
  "role": "assistant",
  "content": [{
    "type": "reasoning",
    "providerOptions": { "cursor": { "modelName": "claude-4.5-opus-high-thinking" } }
  }]
}
```

Subagent or different-model calls can be seen here; there is **no token field**. In model
resolution it is used as the second source after the bubble `modelInfo`.

### 5. Agent transcripts: no tokens

The lines of `~/.cursor/projects/<workspace-slug>/agent-transcripts/<conversation-id>/<id>.jsonl`
carry `{role, message}`; they contain prompt/answer text and tool_use, but **no token counters**.
They are useful for recovering session text, not for a usage ledger.

Subagent transcripts can be under `subagents/` in the same session directory.

In hook logs, `transcript_path` points to this file:

```bash
find ~/.cursor/projects -path '*/agent-transcripts/*/*.jsonl' | head
```

### 6. `ai-code-tracking.db`: a model trace, no tokens

The tables of `~/.cursor/ai-tracking/ai-code-tracking.db`:

| Table | Content |
| --- | --- |
| `conversation_summaries` | `conversationId`, `model`, `mode`, `updatedAt` |
| `ai_code_hashes` | Generated code hashes, `model`, `requestId`, `conversationId` |
| `tracked_file_content` | Edited file content + model |
| `scored_commits` | AI/human line split per commit |

This database tracks **which model was used in which session** and the code contribution; it
carries no token counter (on this machine `ai_code_hashes.model` is empty and only
`conversation_summaries` may be filled in).

### 7. Cursor CLI / statusline (optional)

The Cursor Agent CLI statusline JSON has a `context_window` field: `total_input_tokens`,
`total_output_tokens` (often `null`), `context_window_size`, `used_percentage`. These are
**estimated / instantaneous** values; they are not as structured as the SQLite ledger.

## Observed model identities

Cursor's model catalogue changes over time. The identities seen in `composerData.modelConfig.modelName`
and the bubble/agentKv records on this machine (September 2026, Cursor 3.14.7):

| Model identity | Type | Note |
| --- | --- | --- |
| `composer-2.5` | Cursor first party | The default Agent/Chat family |
| `composer-2.5` + Fast flag | Cursor first party | **Not** a separate model identity in Cursor: `modelConfig.modelName` is still `"composer-2.5"`, and the Fast variant is marked with `selectedModels[].parameters: [{id:"fast", value:"true"}]`. tokengraph's hook adapter names it as a separate model with the `-fast` suffix (`composer-2.5-fast`); see "tokengraph integration". |
| `composer-2-fast` | Cursor first party | The old fast tier |
| `default` | Auto router | The real model is resolved in AgentKv |
| `claude-sonnet-4-6` | Anthropic | |
| `claude-4.6-opus-high-thinking` | Anthropic | Thinking |
| `claude-4.5-opus-high-thinking` | Anthropic | Thinking |
| `claude-4.5-sonnet-thinking` | Anthropic | Thinking |
| `claude-4.6-sonnet-medium-thinking` | Anthropic | Thinking |
| `claude-opus-4-8` | Anthropic | |
| `gemini-3-pro` | Google | |

Model resolution priority (from the experience of external adapters): AgentKv `modelName` →
bubble `modelInfo` → `composerData.modelConfig.modelName` → tracking DB → `default`.

## Composer 2.5 SDK / Cloud Agents API usage

Composer 2.5's model identity is **`composer-2.5`** and its context window is **200k**.
Programmatic use goes through Cursor's agent runtime: the SDK can be used for local workspaces and
the Cloud Agents API for jobs hosted by Cursor. This runs the Cursor agent, which can use tools,
rather than a raw text-completion endpoint ([model documentation](https://cursor.com/docs/models/cursor-composer-2-5),
[SDK](https://cursor.com/docs/sdk/python),
[Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)).

### Python SDK: local agent and token counters

Install the `cursor-sdk` package and put a Cursor user API key or a service account API key into
the `CURSOR_API_KEY` environment variable. A Team Admin API key is not accepted for SDK
authentication. SDK usage follows the plan's Cursor model pool and billing rules; it shows up in
the spend dashboard with an SDK label.

```bash
pip install cursor-sdk
export CURSOR_API_KEY="your-cursor-api-key"
```

```python
import os
from cursor_sdk import (
    Agent,
    LocalAgentOptions,
    ModelParameterValue,
    ModelSelection,
)

model = ModelSelection(
    id="composer-2.5",
    params=[ModelParameterValue(id="fast", value="false")],
)

with Agent.create(
    model=model,
    local=LocalAgentOptions(cwd=os.getcwd()),
) as agent:
    run = agent.send("Summarise this repository")
    result = run.wait()

    if result.usage is not None:
        usage = result.usage
        print(
            f"input={usage.input_tokens:,} output={usage.output_tokens:,} "
            f"cache_read={usage.cache_read_tokens:,} "
            f"cache_write={usage.cache_write_tokens:,} "
            f"total={usage.total_tokens:,}"
        )

    # Fetches the charge that was actually incurred, separately from the token counters.
    billed = agent.get_usage()
    if billed.cost is not None:
        print(f"charged=${billed.cost.charged_cents / 100:.2f}")
```

- Composer 2.5's `fast` parameter can be `false` (Standard) or `true` (Fast). Instead of relying
  on the default variant in the model catalogue, pin the choice with the parameter; the catalogue
  and the variants can differ by account.
- When the runtime reports it, `run.usage` / `result.usage` gives the **cumulative** counters of
  the turns in that agent run. The `usage` event in the stream is the value of a single turn; do
  not add the two together. If no counter was ever reported, the value can be `None`.
- The SDK fields are `input_tokens`, `output_tokens`, `cache_read_tokens` and
  `cache_write_tokens`. `total_tokens` is the sum of these four fields; `reasoning_tokens`, when
  present, is a subset of output and is not added separately. This SDK definition is separate
  from the rule in the IDE hook example above that `input_tokens` includes cache.
- For the real billed amount use `agent.get_usage()`. `cost` records can arrive late after the run
  ends; if the cost has not been computed yet it is `None`. For usage covered by the plan, BYOK
  and credits, `charged_cents` can be zero. Details are in the
  [Python SDK usage documentation](https://cursor.com/docs/sdk/python).

### Cloud Agents REST API: Composer selection and run usage

The Cloud Agents API starts an agent on a repository in the cloud; the documentation marks it as
**public beta**. It uses HTTP Basic auth with a user API key or a service account API key.
`GET /v1/models` is for discovering the model identities and parameters/variants such as `fast`
that the API key can reach.

```bash
curl --request POST \
  --url https://api.cursor.com/v1/agents \
  -u "${CURSOR_API_KEY}:" \
  --header 'Content-Type: application/json' \
  --data '{
    "prompt": { "text": "Summarise this repository" },
    "model": {
      "id": "composer-2.5",
      "params": [{ "id": "fast", "value": "false" }]
    },
    "repos": [{
      "url": "https://github.com/your-org/your-repo",
      "startingRef": "main"
    }]
  }'
```

With the `agent.id` returned in the response you can get the token total of all runs and the
breakdown per run. For a single run add `?runId=<run-id>`:

```bash
curl --request GET \
  --url "https://api.cursor.com/v1/agents/${AGENT_ID}/usage" \
  -u "${CURSOR_API_KEY}:"
```

In the `GET /v1/agents/{id}/usage` response, `inputTokens`, `outputTokens`, `cacheWriteTokens`,
`cacheReadTokens` and `totalTokens` appear in both `totalUsage` and the run records. This
endpoint gives token usage, not dollar cost. The current on-demand prices on the Individual and
Team plans (USD per 1 million tokens):

| Variant | API parameter | Input | Cache read | Output |
| --- | --- | ---: | ---: | ---: |
| Composer 2.5 Standard | `fast=false` | $0.50 | $0.20 | $2.50 |
| Composer 2.5 Fast | `fast=true` | $3.00 | $0.50 | $15.00 |

Cursor's price table shows no separate price for cache write. These are on-demand prices
independent of the plan quota; the SDK `get_usage()` or the Admin API should be used to read the
billed amount. Check the current variant and price on the
[Composer 2.5 model page](https://cursor.com/docs/models/cursor-composer-2-5). For token and cost events at team level, the
[Admin API usage events](https://cursor.com/docs/account/teams/admin-api) provide `model`, `conversationId`, the token breakdown and the
billed amount.

## Mapping to tokengraph fields

The real mapping (see "tokengraph integration" above and
`packages/cli/src/adapters/cursor/aggregator.ts`):

| Cursor source | tokengraph field |
| --- | --- |
| Hook `input_tokens - cache_read_tokens - cache_write_tokens` (clamped to 0) | `inputTokens` |
| Hook `output_tokens` | `outputTokens` |
| Hook `cache_write_tokens` | `cacheCreationTokens` |
| Hook `cache_read_tokens` | `cacheReadTokens` |
| Cache TTL split (5m/1h) | Not available locally → `null` |
| Date | The local date of the hook's `receivedAt` |
| Source | `cursor` (in `KNOWN_SOURCES`, `packages/core/src/sources.ts`) |
| Pricing tier | `standard`, or `fast` if flagged fast (except Composer Fast: it carries its own model name, and the tier is still `standard`) |

Bubble `tokenCount` is **not used**: the adapter is hook-based only (see above).

The weighted token formula (`packages/core/src/tokens.ts`):

```text
input + output + cache_creation + 0.1 × cache_read
```

**The context meter (`promptTokenBreakdown`) must not be included in the daily total**: it has no
output and a snapshot carries the risk of double counting. A **transcript characters / 4
estimate** could be considered only if the counters are missing entirely; the official hook or
bubble counters are preferred. Neither is used in the adapter.

### Pricing

`packages/core/src/pricing.ts` has a separate entry each for `composer-2.5` and
`composer-2.5-fast` (Standard input $0.50 / cache read $0.20 / output $2.50; Fast input $3.00 /
cache read $0.50 / output $15.00, USD per 1M tokens; see the price table under "Cloud Agents REST
API" above). Because Cursor publishes no separate price for cache write ("—" in the price table),
cache write is billed at the plain input price (the same rule as OpenAI models,
`cacheWriteMultiplier`).

The price lookup is independent of the source and works only by model name and pricing tier
(`costForSplitCounts`). So if a Cursor slug is **exactly the same** as an API model in
`pricing.ts` (for example `gpt-5.3-codex`, `gpt-5.4-mini`), it is priced at that model's standard
tier API list price; since Cursor bills third-party models at list price anyway, this is a
reasonable approximation. This holds only for entries whose `cacheWriteMultiplier` is numeric
(OpenAI style, a single cache-write rate); these entries never look at the 5m/1h split of the
cache write.

**Even if a canonical Claude id produced by `normalizeCursorModel` is registered in `pricing.ts`
(for example `claude-opus-4-6`), usage coming through Cursor always stays unpriced; it is never
priced at the standard tier.** The reason: Cursor never reports the 5 minute / 1 hour split of the
cache write (`cacheCreation5mTokens` / `cacheCreation1hTokens` are always `null` on Cursor rows),
and for Anthropic-style entries (`cacheWriteMultiplier: null`) `costForSplitCounts` returns
unpriced when this split is `null`, regardless of tier, the standard tier included. Only the
OpenAI-style entries above never look at the split, so they can be priced with a null split too;
that is why Composer and `gpt-*` matches are priced and Claude matches are not. Slugs specific to
Cursor that do not turn into a canonical Claude id (those with no counterpart in `pricing.ts`,
like `default` and `composer-2-fast`) stay unpriced anyway.

When the pricing tier of a fast-flagged model is `fast` (see above: apart from Composer, the
model name does not change), there are two different outcomes. If the model is an OpenAI-style
entry in `pricing.ts` (a numeric `cacheWriteMultiplier`), the existing `FAST_MODE_MULTIPLIER`
(2×) rule already doubles the rate automatically and prices it, so no separate fast entry is
needed for Cursor. If the model is an Anthropic entry, the null-split rule above already leaves
every tier (the standard one included) unpriced, so the `fast` tier stays unpriced in the same
way. In both unpriced cases the cost is shown as "unknown", never `$0`.

**Side effect on cost totals:** if the same Claude model has usage from both Claude Code (priced)
and Cursor (unpriced, merged into the same model+day row), that model's cost estimate is no longer
fully priced. The CLI's story cards and cost figure treat a model as partly priced when any of its
usage is unpriced, and then show the estimate as a lower bound (for example "≥ $12"). This is
expected, not a bug: the priority is a correct token count, and cost is secondary.

## Per-LLM usage summary: what to read from which file

| LLM family | Where the model identity is | Input tokens | Output tokens | Cache read/write |
| --- | --- | --- | --- | --- |
| Cursor Composer | `composerData.modelConfig`, bubble `modelInfo` | Hook `input_tokens` or bubble `tokenCount.inputTokens` (0 in most new sessions) | Hook `output_tokens` or bubble `tokenCount.outputTokens` | Hook fields |
| Anthropic (Claude) | The same + AgentKv `providerOptions.cursor.modelName` | The same | The same | Hook fields |
| OpenAI (GPT) | `gpt-*` slugs in the catalogue; the `modelConfig` selected in the session | The same | The same | Hook fields |
| Google (Gemini) | `gemini-*` slugs | The same | The same | Hook fields |
| xAI (Grok) | `grok-*` slugs | The same | The same | Hook fields |
| Auto (`default`) | The real `modelName` in AgentKv | The parent turn's hook carries the auto slug; the real model is on the API side | | |

Tab completion (Cursor Tab) is a separate inference pipeline; the agent `state.vscdb` sources do
**not reliably separate** Tab completion tokens. A local structured source for Tab usage was not
verified in this document.

## Enterprise / cloud cross-check

If the local hooks are not enough (especially to merge subagent tokens with the parent), Cursor's
**Admin API** usage events endpoint returns the same `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens` and `conversationId` as billing. This is a channel
independent of the SQLite on the laptop and is outside the scope of the tokengraph CLI adapter.

### A third-party reference tool: `ofershap/cursor-usage-tracker`

This tool uses the **Enterprise Admin API**'s `/teams/filtered-usage-events` endpoint on the
server side (with a team admin key). It reads the fields
`tokenUsage.{inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,totalCents}`, `maxMode`,
`kindLabel` and `isChargeable`; instead of computing the cost with its own price table it uses
the `totalCents` the server returns. The billing rules it notes: Cursor bills third-party models
at the provider's list price; on the Teams/Enterprise plan there is an extra $0.25 per 1M tokens
on the total; Max mode adds 20%; Auto has fixed, blended rates (see the price table above; these
surcharges are not included in tokengraph's Composer 2.5 price entries, see "Not verified"). This
tool does **not clarify** whether the hook's `input_tokens` includes cache: its own `total_tokens`
field is only the sum of input + output, cache not included.

## Comparison with the Codex adapter

| | Codex CLI | Cursor IDE |
| --- | --- | --- |
| Primary source | `token_usage_record` JSONL | `stop` hook → `~/.tokengraph/cursor-events.jsonl` |
| Local root | `$CODEX_HOME` (default `~/.codex`) | `$TOKENGRAPH_HOME` (default `~/.tokengraph`); Cursor's own directories (`Application Support/Cursor`, `~/.cursor`) are not read |
| Dedup key | `response_id` | `generation_id` |
| Model source | `turn_context` | Hook `model` / `model_id` |
| Official schema | Partly observed JSONL | Closed source; the hook fields rest on a forum reply |
| Cache split | OpenAI `cached_input_tokens` | Hook `cache_read_tokens` / `cache_write_tokens` |

## Not verified

- **A real `stop` hook payload was never captured** (there is no Cursor Pro subscription on this
  machine). `eventFromHookPayload` and the adapter were written defensively, following the field
  names in the forum reply, and were not verified with a real payload.
- It is not known whether the token fields arrive filled in on turns that end with `aborted` /
  `error` (the `status` field is stored but not processed).
- It could not be verified whether the Fast variant reaches the hook as a `fast` parameter in
  `model_params` or directly as a model name (`model`/`model_id`); the adapter supports both
  (see "tokengraph integration").
- `~/.cursor/hooks.json` was tested on macOS only; the real path on Windows/Linux (other than the
  one `install-hook` produces with `homedir()`) was not verified.
- That subagent tokens are not added to the parent hook's total (and so are never reported by
  Cursor at all) rests on the forum reply; it was not verified against independent billing.
- Whether the hook's `input_tokens` **really** includes cache reads/writes was not independently
  verified (see the `ofershap/cursor-usage-tracker` note above). If it turns out it does not, the
  aggregator's "N turn(s) reported more cached than total input" clamping note will reveal it: if
  `input_tokens` does not include cache, the fresh-input derivation falls systematically
  negative and this note shows up on every sync.
- Cursor **3.14.7** was observed locally; the bubble `tokenCount` behaviour can differ in other
  versions (the adapter does not read bubbles anyway, but the discovery notes rest on the
  observations in this section).
- `~/.cursor/chats/.../store.db` does not exist on this machine; the protobuf-based chat store
  was not decoded.
- It was not tested whether the cache read/write hook fields arrive filled in for every model
  family.
- No local source was found for Tab completion tokens; the adapter does not count Tab at all.
- On this machine the model columns of `ai-code-tracking.db` are empty; on other installs they may
  be filled in (the adapter does not read this file).
- Mapping third-party Cursor slugs to API-equivalent prices, and Max mode's +20% surcharge, are
  not yet modelled in `pricing.ts` (see "Pricing" above).

## Sources

- [Cursor forum: token usage per request (hooks)](https://forum.cursor.com/t/how-to-obtain-token-usage-per-request/168317)
- [tokenuse.app: Cursor adapter reverse engineering](https://tokenuse.app/docs/development/tools/cursor/)
- [ClawMetry: Cursor runtime data paths](https://clawmetry.com/docs/runtime/cursor/)
- [Cursor forum: agent transcript location](https://forum.cursor.com/t/cant-access-chat-history-since-latest-update/158688)
- [deja-vu: Cursor session format](https://vshulcz.github.io/deja-vu/registry/cursor.html)
- [ofershap/cursor-usage-tracker: a reference tool based on the Enterprise Admin API](https://github.com/ofershap/cursor-usage-tracker)
- `packages/core/src/sources.ts`: the `cursor` source definition
- `docs/agents/codex-usage.md`: the sibling document (Codex CLI local usage)
