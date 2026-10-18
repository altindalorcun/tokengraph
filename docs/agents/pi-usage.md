# pi coding agent local token usage data

This note explains where, and in what format, the pi coding agent (`pi`, npm `@earendil-works/pi-coding-agent`,
formerly `@mariozechner/pi-coding-agent`) stores per-request token usage in its session files, and how to
normalise it into tokengraph's fields. The adapter lives in `packages/cli/src/adapters/pi/`; this note is the
research behind it. pi is open source (MIT), so every field below is checked against its code, not a third-party
parser. Related forks (oh-my-pi and similar) write their own folders and are not read.

In short: pi writes one JSON line per session entry into `~/.pi/agent/sessions/**/*.jsonl`. An assistant
`message` entry holds one API response with a `usage` object whose `input` is **exclusive** of cache, so the
four counters map straight onto tokengraph's. `reasoning` is a subset of `output` and is never added.
`cacheWrite1h` (Anthropic and Bedrock only) gives the 5m/1h cache split. Forked sessions copy entries into a new
file, so requests are deduplicated across files.

## Local data location

- Agent folder: `$PI_CODING_AGENT_DIR` (a leading `~` is expanded) when set, otherwise `~/.pi/agent`. The same
  relative path on macOS, Linux and Windows (`os.homedir()`). The variable name comes from pi's
  `piConfig.name` (`pi`), see `ENV_AGENT_DIR` and `getAgentDir()` in `packages/coding-agent/src/config.ts`.
- Sessions: `<agent folder>/sessions/--<cwd>--/<ISO time with : and . replaced by ->_<session id>.jsonl`, where
  `<cwd>` is the working directory with the leading separator removed and `/ \ :` replaced by `-`
  (`getDefaultSessionDirPath`, `core/session-manager.ts`).
- `$PI_CODING_AGENT_SESSION_DIR` (also `~`-expanded), the `sessionDir` setting and the `--session-dir` flag move
  session storage elsewhere (`main.ts`, `core/settings-manager.ts`). The adapter follows the environment
  variable and also keeps reading `<agent folder>/sessions`, because sessions written before the variable was set
  stay there. The setting and the flag are per-install or per-run and cannot be seen from a later `sync`, so they
  are not followed. (tokscale and token-monitor read only the fixed default path.)
- The adapter reads every `*.jsonl` under those folders, line by line, and only the `type`, `id`, `timestamp`,
  `provider`, `api`, `model`, `responseModel`, `responseId` and `usage` fields. Message text, tool arguments, the
  header's `cwd` and the compaction summaries are never kept.

## Record schema

JSONL. The first line is a header (`{"type":"session","version":3,"id","timestamp","cwd","parentSession"?}`);
the rest are tree entries with `type`, `id` (8 hex characters, unique only within one file), `parentId` and an
ISO `timestamp` (the time the entry was appended).

Entries that carry a `Usage` (`packages/ai/src/types.ts`):

1. `{"type":"message","message":{"role":"assistant","api","provider","model","responseModel"?,"responseId"?,"usage":{...},"stopReason","timestamp":<unix ms>}}`. One entry is one API response. Counted.
2. `{"type":"usage","kind":"cache_warm"|<any>,"provider","model","usage":{...}}`. Model-attributed calls that are not
   part of the conversation. `docs/session-format.md`: "treat unknown kind values as normal usage". Counted; the
   time is the entry's ISO `timestamp`.
3. `compaction.usage`, `branch_summary.usage` (optional) and `toolResult` messages' `usage` (a sum of nested model
   calls). These name no model: the compaction and branch-summary entries have none, and a tool result's usage is
   "not part of main LLM context accounting". They are **not counted**; a note reports how many were skipped.

`Usage` is `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{...}}`.

```json
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2026-10-03T14:00:02.000Z","message":{"role":"assistant","api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","responseId":"msg_01...","usage":{"input":12,"output":340,"cacheRead":50000,"cacheWrite":800,"cacheWrite1h":0,"totalTokens":51152,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1759500002000}}
```

## Token semantics

- `input` is exclusive of cache; every provider is normalised inside pi (Anthropic maps `input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens` 1:1; OpenAI Responses and Completions subtract cached
  and cache-write tokens from the prompt count; Google subtracts `cachedContentTokenCount`). So
  `totalTokens = input + output + cacheRead + cacheWrite`, and tokengraph's `inputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheCreationTokens` are the four fields unchanged.
- `reasoning` is a subset of `output` ("`output` already includes these tokens", `types.ts`). Never added.
- Per request, not cumulative. A missing `cacheRead` or `cacheWrite` (very old files) is 0. Missing or non-integer
  `input` / `output` makes the record malformed: skipped and counted in a note.
- Cache-write TTL: `cacheWrite1h` is a subset of `cacheWrite` and is set only by the Anthropic Messages API
  (`api/anthropic-messages.ts`, and written as `|| 0` when the API gave no `cache_creation` object) and Bedrock
  Converse (`api/bedrock-converse-stream.ts`, from `cacheDetails`). The adapter trusts it only when the message's
  `api` is `anthropic-messages` or `bedrock-converse-stream` (or, for a `usage` entry, the provider is `anthropic`
  or `amazon-bedrock`) **and** the field is present: then 1h = `min(cacheWrite1h, cacheWrite)` and 5m = the
  rest. Every other request, and an Anthropic request from an older file, has an unknown split (`null`, never 0).
- Pricing tier: `tierForModel` from the whole prompt (input + cache read + cache write). pi records no fast-mode
  flag.
- An all-zero usage object (a request that failed before the provider reported anything) is skipped silently.

## Dedup unit and traps

- Key: `(provider, message.responseId)` when `responseId` is present; otherwise start time, provider, model and the
  four counters (`usage` entries have no response id, so they always use that form). Copies merge by per-field max
  (`RequestBuckets`); the first copy's day and model win.
- **Forks.** `/fork`, `/clone` and `createBranchedSession` write a new file holding copies of the entries, with
  the same entry ids, message timestamps and usage (`core/session-manager.ts`, `createBranchedSession` and
  `forkFrom`); the header's `parentSession` points at the source. Counting both files would double those requests;
  the key above merges them. Entry ids cannot be the key: they repeat across forks and are unique only per file.
- **Branches.** `/tree` keeps abandoned branches in the same file; those requests were billed, so every `message`
  entry is counted, not only the active path.
- **Rewrites.** Migrations and `_rewriteFile` rewrite files in place; the same key makes that idempotent.
- Aborted or errored responses carry whatever the provider reported; it is counted as recorded.
- No mirrored provider: pi calls provider APIs directly (Anthropic, OpenAI, OpenAI Codex, GitHub Copilot, ...). It
  does not wrap the Claude Code, Codex or Copilot CLIs and writes nothing into their folders, so no provider is
  skipped, unlike Cline and OpenCode.

## Model attribution

`message.responseModel` (the concrete model the provider reported) when present, otherwise `message.model`; for a
`usage` entry its `model`. The id goes through the shared `canonicalModelId(provider, id)`, so
`us.anthropic.claude-sonnet-4-5-...-v1:0` under `amazon-bedrock` and `anthropic/claude-opus-4.5` from a gateway
become `claude-sonnet-4-5` and `claude-opus-4-5`. Other ids stay as recorded and stay unpriced if the price table
has no entry.

## Timestamp

`message.timestamp` is the request start in unix milliseconds. When it is missing the entry's ISO `timestamp` is
used; `usage` entries have only the latter. The instant is bucketed into a local calendar day like every other
adapter; `since` compares that instant, and files whose mtime is before `since` are not opened.

## Retention

pi has no automatic deletion of session files (nothing in `session-manager.ts`, `docs/sessions.md` or
`docs/settings.md`); the user deletes them, and `/resume` can delete through the `trash` command. So `status`
has no retention check for pi. Deleted sessions leave the ledger untouched, which only grows.

## Format history

Session version 3 (v1 linear, v2 tree ids, v3 `hookMessage` renamed to `custom`); pi migrates old files when it
loads them. `usage` entries, `cacheWrite1h` and `reasoning` are newer additions, so every `Usage` field beyond
the four counters is treated as optional. The npm package was renamed to `@earendil-works/*` in 2026; the folder
did not change.

## Checked against real runs

pi 0.73.1 (`@mariozechner/pi-coding-agent`). Method: the real agent was installed into a throwaway folder and run with a throwaway `HOME` against a local fake LLM endpoint (OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, streaming). The endpoint gave every request distinct fresh-input, cache-read, cache-write and output counts and logged them; that log is the independent count. `tokengraph sync --local` then read the agent's own files in that home, and its totals were compared field by field with the log.

- Runs: two `-p` prompts on an `openai-completions` provider and two on an `anthropic-messages` provider (one of
  them `--continue`), then one prompt per provider that made the model call the `bash` tool first. 8 requests in
  all; fresh input, cache read, cache write and output matched the endpoint exactly, so `input` is indeed
  exclusive of cache and the per-request entries are complete.
- Not observed: whether `/fork` always reuses the original `responseId` (it copies entries verbatim in the code
  read). Compaction, branch-summary and nested tool-call usage is skipped because it names no model; for a heavy
  user this undercounts a small amount, and the note reports how many records were skipped.

## Sources

- pi-mono (MIT), commit [`482c138`](https://github.com/badlogic/pi-mono/tree/482c1381a00d8d00bc81697e4a980c593db6803e):
  `packages/coding-agent/src/core/session-manager.ts`, `src/config.ts`, `src/main.ts`, `src/core/nested-tool-calls.ts`,
  `docs/session-format.md`, `docs/sessions.md`, `docs/settings.md`; `packages/ai/src/types.ts`,
  `src/api/anthropic-messages.ts`, `src/api/bedrock-converse-stream.ts`.
