# Gemini CLI local token usage data

This note explains where, and in what format, Gemini CLI (`google-gemini/gemini-cli`) stores
per-request token usage in its local files, and how to normalise it into tokengraph's fields. The
adapter lives in `packages/cli/src/adapters/gemini-cli/`; this note is the research behind it.
Gemini CLI was not installed on the machine where the research was done. Everything below was
worked out from the source code (main, commit [`2fe7c2d`](https://github.com/google-gemini/gemini-cli/tree/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18), 25 September 2026; latest
stable release v0.61.0), the official documentation and two third-party parsers (ccusage,
tokscale); it was not verified against a real local file.

In short: the `usageMetadata` of every Gemini API response is written as `tokens` on the
`type: "gemini"` message in the session record. Recording is **always on** by default (there is no
setting to turn it off), but sessions are **deleted after 30 days** by default, and some side LLM
calls (web search, compression, the routing classifier and so on) are never recorded at all.

These counters are local session token usage; they are not a Google AI Studio / Vertex / Code
Assist bill or quota report.

## Local data location

Root directory: `homedir()/.gemini`. `homedir()` returns `GEMINI_CLI_HOME` if it is set, otherwise
`os.homedir()`, so `GEMINI_CLI_HOME` is **not `.gemini` itself but its parent directory**
(`$GEMINI_CLI_HOME/.gemini/...`). The official documentation says the same: "The CLI will create a
`.gemini` folder inside this directory."
([paths.ts#L22-L28](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/utils/paths.ts#L22-L28),
[storage.ts#L54-L60](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/config/storage.ts#L54-L60),
[configuration.md `GEMINI_CLI_HOME`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/docs/reference/configuration.md))

Runtime data (chat records included) lives under `getGlobalRuntimeDir()`; normally that is
`~/.gemini`, but in the macOS Seatbelt sandbox (`SANDBOX=sandbox-exec`) it is
**`~/.cache/.gemini`**. In a Docker/Podman sandbox the directory is mounted into the container
ephemerally, so those sessions do not stay on the host.
([storage.ts#L90-L108](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/config/storage.ts#L90-L108))

```text
<runtime>/tmp/<project-id>/chats/session-<YYYY-MM-DDTHH-MM>-<sessionId[0:8]>.jsonl   # main session (v0.39+)
<runtime>/tmp/<project-id>/chats/session-<YYYY-MM-DDTHH-MM>-<sessionId[0:8]>.json    # old format (v0.4-v0.38)
<runtime>/tmp/<project-id>/chats/<parentSessionId>/<sessionId>.jsonl                 # subagent session (v0.37+)
<runtime>/tmp/<project-id>/logs.json              # the user's prompt log only, no tokens
<runtime>/tmp/<project-id>/checkpoint-<tag>.json  # /chat save: the Content[] history, no tokens
```

- **`<project-id>`**: in older versions the SHA-256 hash of the project root (the docs still say
  `<project_hash>`); in current versions a readable slug given by `ProjectRegistry` (kept in
  `projects.json`, with a `.project_root` marker file in the directory). The hash-to-slug
  migration **copies** the directory (`fs.promises.cp`) and does not delete the old one, so the
  same session file can sit under both `tmp/<hash>/chats/` and `tmp/<slug>/chats/`.
  ([storage.ts#L306-L324](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/config/storage.ts#L306-L324),
  [storageMigration.ts#L45](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/config/storageMigration.ts#L45))
- If two files collide within the same minute, the name becomes `session-<ts>-<n>-<shortId>.jsonl`.
  ([chatRecordingService.ts#L476-L521](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingService.ts#L476-L521))
- The adapter should scan only `tmp/*/chats/` recursively (`*.json`, `*.jsonl`); it must not read
  `logs.json`, `checkpoint-*.json`, `tool-outputs/`, `projects.json` or OAuth/credential files.
  The `*.tmp-<pid>` files created while writing and the `*.unreadable-<ms>` backups of corrupt
  files are skipped naturally because their extensions do not match.

```bash
GEMINI_ROOT="${GEMINI_CLI_HOME:-$HOME}/.gemini"

# Session files (main + subagent, old + new format)
find "$GEMINI_ROOT/tmp" -path '*/chats/*' -type f \( -name '*.jsonl' -o -name '*.json' \) -print

# Only gemini messages that carry tokens; does not print text content (for JSONL).
find "$GEMINI_ROOT/tmp" -path '*/chats/*' -type f -name '*.jsonl' \
  -exec jq -c 'select(.type == "gemini" and .tokens != null)
               | {id, timestamp, model, tokens}' {} +
```

### Is recording on?

Yes, always. `ChatRecordingService` is created and started unconditionally in every `GeminiChat`
instance; there is no setting that turns it off (the one exception: when the disk is full,
recording stops for that session after `ENOSPC`). Interactive mode, `gemini -p` (headless) and
subagents (`local-executor.ts` → `chat.initialize(undefined, 'subagent')`) are recorded along the
same path.
([geminiChat.ts#L424-L438](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/core/geminiChat.ts#L424-L438),
[local-executor.ts#L1115-L1123](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/agents/local-executor.ts#L1115-L1123),
[session-management.md](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/docs/cli/session-management.md): "Token usage statistics (input, output, cached, etc.)" is among
what is recorded)

### The telemetry file (not a primary source)

OpenTelemetry `api_response` events carry the same fields (`input_token_count`,
`output_token_count`, `cached_content_token_count`, `thoughts_token_count`, `tool_token_count`,
`total_token_count`, `model`, `prompt_id`) and also cover the side calls
([telemetry/types.ts `ApiResponseEvent`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/telemetry/types.ts#L653-L717)).
But telemetry is off by default, and writing it to a local file requires the user to set
`telemetry.enabled` + `telemetry.target: "local"` + `telemetry.outfile`; the `api_response` event
also has no stable per-request id. So it should not be used as a source for tokengraph.

## Record schema (JSONL, v0.39+)

The file is **append-only** JSONL; each line is an independent JSON record, and there are four
kinds of line ([chatRecordingTypes.ts](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingTypes.ts), reader:
[`loadConversationRecord`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingService.ts#L133-L400)):

1. **Metadata line** (first line): `sessionId` + `projectHash` (+ `startTime`, `lastUpdated`,
   `kind: "main" | "subagent"`, `directories`).
2. **Message line**: any record with a string `id` field (`type`: `user`, `gemini`, `info`,
   `error`, `warning`).
3. **`$set` line**: a metadata update (`lastUpdated`, `summary`, ...); sometimes a full copy of the
   whole message array in `$set.messages` (a checkpoint).
4. **`$rewindTo` line**: `/rewind`; that id and everything after it is deleted in Gemini CLI's
   view.

Example (field structure from the source; token figures from ccusage's test fixture,
[loader.rs](https://github.com/ryoppippi/ccusage/blob/32ef4346fc9d0d757a544cef5a04975884e4b773/rust/adapters/gemini/src/loader.rs)):

```jsonl
{"sessionId":"3f1c…","projectHash":"9ab0…","startTime":"2026-05-17T11:07:00.000Z","lastUpdated":"2026-05-17T11:07:00.000Z","kind":"main"}
{"id":"7d2e…","timestamp":"2026-05-17T11:07:10.000Z","type":"user","content":[{"text":"…"}]}
{"$set":{"lastUpdated":"2026-05-17T11:07:10.000Z"}}
{"id":"msg-a","timestamp":"2026-05-17T11:07:32.000Z","type":"gemini","content":"…","thoughts":[…],"tokens":{"input":15327,"output":23,"cached":11526,"thoughts":919,"tool":7,"total":16276},"model":"gemini-3-flash-preview"}
{"$set":{"lastUpdated":"2026-05-17T11:07:32.000Z"}}
{"id":"msg-a","timestamp":"2026-05-17T11:07:32.000Z","type":"gemini","content":"…","tokens":{…same…},"model":"gemini-3-flash-preview","toolCalls":[{"id":"read_file__…","name":"read_file","status":"success","…":"…"}]}
```

The last line matters: **the same message is written several times with the same `id`.**
On every update (tokens added, a tool call added, tool result masking) `pushMessage` appends the
whole message again
([chatRecordingService.ts#L650-L665](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingService.ts#L650-L665)).

### The `tokens` object

```ts
export interface TokensSummary {
  input: number;     // promptTokenCount
  output: number;    // candidatesTokenCount
  cached: number;    // cachedContentTokenCount
  thoughts?: number; // thoughtsTokenCount
  tool?: number;     // toolUsePromptTokenCount
  total: number;     // totalTokenCount
}
```

([chatRecordingTypes.ts#L19-L26](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingTypes.ts#L19-L26))
The values are copied from `usageMetadata` as they are; a missing field becomes `0`
([`recordMessageTokens` #L746-L775](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingService.ts#L746-L775)).
If the `tokens` field is missing or `null` (a response with no usageMetadata, a synthetic
message), that message carries no usage.

### One message = one API request

`processStreamResponse` buffers the last `usageMetadata` that arrives during a stream (in a Gemini
stream the last chunk carries the cumulative total), records it with `recordMessageTokens` if the
stream ends **successfully**, and then writes a single `gemini` message. The tokens are either
added to the last (token-less) gemini message or queued and attached to the next gemini message;
tokens are written to a message only once (the `!lastMsg.tokens` guard). Each model call in a
tool-call loop produces a separate gemini message.
([geminiChat.ts#L1354-L1462](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/core/geminiChat.ts#L1354-L1462),
[#L1636-L1664](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/core/geminiChat.ts#L1636-L1664))

### Model and timestamp

- **`model`**: the gemini message's own field. The value is the `lastModelToUse` passed to
  `processStreamResponse`, the model id actually called **after** routing, `auto` alias
  resolution and quota fallback (for example Pro → Flash), such as `gemini-2.5-pro`,
  `gemini-3-pro-preview` or `gemini-3-flash-preview`. It is not the `modelVersion` in the API
  response. A single session can have several models; the model must be read per message, not per
  session. If a message carries `tokens` but no `model`, use `unknown`.
  ([geminiChat.ts#L1141-L1146](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/core/geminiChat.ts#L1141-L1146))
- **`timestamp`**: `new Date().toISOString()` (UTC, ms) when the message object is created. It
  does not change in re-appended copies. It is the moment near the end of the stream, not the
  start of the request, so the day of a request that straddles a day boundary is decided by it.

### Dedup key

**`message.id`** (normally `randomUUID()`), global across all files:

- The same `id` appears several times in the same file (the rewrites above): count it once. Since
  the token field is written once, which copy is taken does not change the total; the copy with
  `tokens` filled in should be preferred (if the first copy has no `tokens` yet, a later copy
  gets them).
- The same `id` can appear in different files: the hash-to-slug directory copy, the `.json` →
  `.jsonl` migration (the old `.json` is not deleted, a `.jsonl` is written next to it,
  [#L436-L460](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingService.ts#L436-L460)), `$set.messages` checkpoints and file rewrites. All of them keep the same
  `id`.
- Subagent sessions are separate files with their own `sessionId`; their messages are **not
  repeated** in the main session (the main session keeps only the tool-call record), so they must
  be counted separately.
- `(sessionId, id)` could also be used (`sessionId` stays the same in copies), but since `id` is a
  UUID it is enough on its own.

### `$rewindTo` and `$set.messages`

- Do not apply **`$rewindTo`**. The API calls of rewound messages were really made and billed;
  Gemini CLI only removes them from the visible history. For tokengraph, "every message id with
  tokens that has been seen once" is counted.
- Messages inside `$set.messages` are copies of earlier lines (tokens preserved); since they are
  deduplicated by the same id, reading or skipping them does not change the result. The safe
  route is to collect them as candidates too and deduplicate by id (it prevents loss if the older
  lines are somehow missing).
- Since the file is append-only, older lines are not modified in place; the one exception is
  `rewriteConversationFile` (when the file is unreadable): it keeps the old file as
  `*.unreadable-<ms>` and writes a new one.

## Old format (v0.4-v0.38): a single JSON document

`ChatRecordingService` was added in v0.2.0, and it was wired into `GeminiChat` and really started
recording in v0.4.0 ([b5dd6f9](https://github.com/google-gemini/gemini-cli/commit/b5dd6f9ea)).
Until v0.39.0 ([f744913 "migrate chat recording to JSONL streaming"](https://github.com/google-gemini/gemini-cli/commit/f74491358)) the file was a
**single JSON document** named `session-*.json`, **rewritten in place** with `writeFileSync` on
every update:

```json
{
  "sessionId": "…", "projectHash": "…", "startTime": "…", "lastUpdated": "…",
  "messages": [
    { "id": "…", "timestamp": "…", "type": "gemini", "content": "…", "model": "gemini-2.5-pro",
      "tokens": { "input": 0, "output": 0, "cached": 0, "thoughts": 0, "tool": 0, "total": 0 } }
  ]
}
```

- The shape of `TokensSummary` has been the same since the first version; `thoughts` and `tool`
  are optional (0 if absent).
- In those versions `recordMessageTokens` was called for every chunk that had `usageMetadata`; the
  last chunk's value won (cumulative), so the result is normally the same. Because the usage of
  failed stream attempts was not buffered, a retry could in theory overwrite their values;
  buffering arrived in v0.55.0 ([f47d6c6](https://github.com/google-gemini/gemini-cli/commit/f47d6c6f7)).
- In the JSON format, rewind (`$rewindTo`) really deletes messages from the array, so the tokens
  of rewound requests cannot be recovered in those versions.
- Before v0.37, subagents were also written under `chats/` as `session-*.json` (with
  `kind: "subagent"` inside); from v0.37 they moved under `chats/<parentSessionId>/`.
- v0.1-v0.3: no per-request token record (only `logs.json` and checkpoints).

The adapter must read both formats: if the file parses as a single JSON object with a `messages`
array it is the old format; otherwise it is line-by-line JSONL.

## Retention and deletion

- **`general.sessionRetention`**: `enabled` defaults to `true`, `maxAge` defaults to `"30d"`,
  `minRetention` is `"1d"`, `maxCount` is undefined. Sessions whose `lastUpdated` is older than
  the cutoff are deleted (together with subagent directories, tool outputs and logs). Cleanup runs
  when Gemini CLI starts and **only in the current project's** `chats/` directory.
  ([settingsSchema.ts#L389-L432](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/cli/src/config/settingsSchema.ts#L389-L432),
  [sessionCleanup.ts#L102-L364](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/cli/src/utils/sessionCleanup.ts#L102-L364),
  [session-management.md "Session retention"](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/docs/cli/session-management.md))
- History: the feature was added in v0.9.0 (off by default); in v0.30.0 30 days became the default
  but with a warning dialog ([4e1b3b5](https://github.com/google-gemini/gemini-cli/commit/4e1b3b5f5)); since v0.33.0 it has been on by default without
  a warning ([06ddfa5](https://github.com/google-gemini/gemini-cli/commit/06ddfa5c4)).
- Other ways data is deleted: `/exit --delete`, deleting from the session browser, and automatic
  deletion of empty sessions with no "resumable" content (v0.47+).
- Consequence: as with Claude Code, totals must only grow (the existing max-merge invariant);
  data older than 30 days before the first sync most likely does not exist.

## Mapping to tokengraph fields

Gemini API field meanings
([`@google/genai` `GenerateContentResponseUsageMetadata`](https://github.com/googleapis/js-genai/blob/main/src/types.ts),
[Gemini API UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata)):

- `promptTokenCount`: "When `cached_content` is set, this also includes the number of tokens in
  the cached content." So **`input` INCLUDES cached tokens**; `cached` is a subset of it.
- `thoughtsTokenCount`: thinking tokens, **not included** in `candidatesTokenCount`, counted
  separately.
- `toolUsePromptTokenCount`: "tokens in the results from tool executions, which are provided back
  to the model as input", not included in `promptTokenCount`.
- `totalTokenCount`: "the sum of `prompt_token_count`, `candidates_token_count`,
  `tool_use_prompt_token_count`, and `thoughts_token_count`"; `cached` is not added separately
  (it is already inside the prompt).

Cross-checks:

- Gemini CLI's own `/stats` calculation: `tokens.input = max(0, prompt − cached)`
  ([uiTelemetry.ts#L222-L247](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/telemetry/uiTelemetry.ts#L222-L247)).
- ccusage fixture: `15327 + 23 + 919 + 7 = 16276 = total`, so `total` does not include `cached`
  separately, while `thoughts` and `tool` are summed separately.
- Pricing: "Output price (including thinking tokens)"; for caching there is only a read price and
  (for explicit caches) an hourly storage fee, and no cache-write line. Gemini CLI does not create
  explicit `cachedContent` (it only passes it in the request), so `cached` is in practice an
  implicit cache read.
  ([Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing),
  [context caching](https://ai.google.dev/gemini-api/docs/caching))

Normalisation (per message, before summing):

| Gemini CLI `tokens` field | tokengraph field |
| --- | --- |
| `max(0, input − cached) + (tool ?? 0)` | `inputTokens` |
| `output + (thoughts ?? 0)` | `outputTokens` |
| none (Gemini has no cache-write concept or counter) | `cacheCreationTokens` = `0` |
| `cached` | `cacheReadTokens` |
| no 5m/1h split | `cacheCreation5mTokens`, `cacheCreation1hTokens`: `null` |

Reasoning:

- `cached` is inside `input`: if it is not subtracted, cache reads are counted twice, once as full
  input and once as cache read.
- `thoughts` is outside `output` but billed like output: if it is not added it is undercounted;
  this is consistent with Claude (thinking is inside `output_tokens`) and Codex
  (`reasoning_output_tokens` is inside `output_tokens`). Note: the "output" on Gemini CLI's
  `/stats` screen shows only `candidates`; our count will be larger than that by `thoughts`, and
  this is deliberate.
- `tool` is outside `input` and is tokens given to the model as input, so it is added to input.
  ccusage and tokscale do the same.
- Consistency check (for diagnostics, not for correction): `total == input + output + thoughts +
  tool`. If `cached > input` is seen it should be clamped and a diagnostic counter incremented
  (like the clamp diagnostic in Codex); no correction should be made by guessing.
- ccusage and tokscale do not subtract `cached` from input unless `total == input + output +
  thoughts + tool` holds (a defence against older or other formats). Since `input` is always
  `promptTokenCount` in the Gemini CLI source, subtracting unconditionally is right for us; but
  keeping the same equality check as a diagnostic is a good early warning.

Pricing tier: Gemini 2.5 Pro / 3.x Pro apply a different (long-context) price to requests whose
prompt (`promptTokenCount`, cached included) exceeds 200K; the tier must be decided per request
from `input` (the un-normalised `promptTokenCount`). The threshold and the model list need to be
verified separately against the price table (outside the scope of this note).

## Usage that is not recorded (undercounting, not overcounting)

The chat record covers only the main `GeminiChat` / subagent `GeminiChat` streams. Side calls made
through `BaseLlmClient` / `generateContent` are **not written to any session file**: the
`web_search` and `web_fetch` tools, chat compression (`chatCompressionService`,
`contextCompressionService`, `toolDistillationService`), model routing classifiers,
`nextSpeakerChecker`, `loopDetectionService`, `editCorrector`, the session summary
(`sessionSummaryService`) and `summarizer`. The usage of requests retried because of an invalid
stream (`InvalidStreamError`) is not recorded either. These show up only in opt-in telemetry. The
result: daily totals are a **lower bound** of real API usage; nothing is counted twice, but some of
it is never seen.

## Third-party parsers (cross-check)

- **ccusage** ([rust/adapters/gemini/src/parser.rs @32ef434](https://github.com/ryoppippi/ccusage/blob/32ef4346fc9d0d757a544cef5a04975884e4b773/rust/adapters/gemini/src/parser.rs), [docs](https://ccusage.com/guide/gemini/)): reads
  `*.json` + `*.jsonl` under `~/.gemini/tmp/*/chats/` (override: its own `GEMINI_DATA_DIR`). Input
  = `input − cached` (conditional, #L400-L415) `+ tool` (#L325); cache read = `cached`;
  `thoughts` is kept as "extra" / reasoning and added to output in the cost (#L456). Dedup is by
  `id` **within the same JSONL file only**, last copy wins (#L193); there is no dedup across files
  (hash/slug copies, the `.json` + `.jsonl` pair), so it overcounts in those cases. It is marked
  "experimental".
- **tokscale** ([crates/tokscale-core/src/sessions/gemini.rs @1d9a939](https://github.com/junhoyeo/tokscale/blob/1d9a9395418efc6952944b794097935d7d6fa1e8/crates/tokscale-core/src/sessions/gemini.rs)): the same
  normalisation (`normalize_gemini_session_input_and_cache` #L515, `tool` added to input
  #L259-L290, `reasoning` = `thoughts`, `cache_write` = 0); last-copy dedup by `id` within a JSONL
  (#L391); no dedup across files. It takes the root directory as `$GEMINI_CLI_HOME/tmp`
  ([clients.rs#L450-L461](https://github.com/junhoyeo/tokscale/blob/1d9a9395418efc6952944b794097935d7d6fa1e8/crates/tokscale-core/src/clients.rs#L450-L461)); according to the Gemini CLI source the correct path is
  `$GEMINI_CLI_HOME/.gemini/tmp`.

Neither tool applies `$rewindTo` (they count rewound requests), the same as our choice.

## Adapter recommendation (summary)

1. Roots: `${GEMINI_CLI_HOME:-~}/.gemini/tmp` and (if present) `~/.cache/.gemini/tmp`.
2. Under `*/chats/**`, `*.jsonl` and `*.json`; no other file is opened.
3. JSONL: parse each line separately; collect records with `type == "gemini"` and a `tokens`
   object (and those inside `$set.messages`) as candidates. JSON: `messages[]`.
4. A global `Map<id, record>`; a copy with tokens is preferred over one without. `$rewindTo` is
   ignored.
5. The normalisation above; the date is the local day from `timestamp` (`dateKey`); the model is
   the message's `model` field (`unknown` if missing); the source name must be added to
   `KNOWN_SOURCES` (here `gemini-cli`).
6. Only counters are kept; `content`, `thoughts`, `toolCalls`, file paths, `summary` and
   `directories` are never read or stored.

## Not verified

- Gemini CLI was not on the research machine and no real session file was seen. The schema and
  behaviour come entirely from the source code; the example token figures come from ccusage's
  fixture.
- No real record was seen in which `tool` (`toolUsePromptTokenCount`) is non-zero. Because the
  main chat does not use Gemini's built-in tools (Google Search grounding and so on), it is
  expected to be 0 in practice; adding it to input rests on the SDK documentation.
- That `cachedContentTokenCount` is a subset of `promptTokenCount` was verified from the SDK/API
  documentation and Gemini CLI's `/stats` calculation; that the Code Assist (OAuth,
  `cloudcode-pa`) path passes `usageMetadata` through unchanged was seen in the code
  ([converter.ts#L158](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/code_assist/converter.ts#L158)), but that server fills the fields with the same meaning as the
  API was not verified separately.
- Differences such as `trafficType` / provisioned throughput on Vertex AI are not written to the
  record; their price effect cannot be known.
- The version mapping was worked out from git tags (the tag containing the first stable release);
  each version's npm package was not opened and checked separately. In particular it is assumed
  that the `tokens` field is always filled in the intermediate versions between v0.4 and v0.38.
- Data that was rewound in the old `.json` format or deleted by the 30-day cleanup cannot be
  recovered; how much was lost cannot be measured.
- The share of side calls (web search, compression, routing...) in the daily total is unknown; it
  can be measured only with telemetry.
- The `~/.cache/.gemini` path in the Seatbelt sandbox comes from the source; it was not observed
  on a real install. That Docker sandbox sessions never stay on the host also rests on a comment
  in the source.
- The cost is API-equivalent; with a free Code Assist / Google account quota it is not a real
  bill.

## Sources

- [gemini-cli @2fe7c2d, `chatRecordingTypes.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingTypes.ts): `TokensSummary`, message and JSONL record types.
- [gemini-cli @2fe7c2d, `chatRecordingService.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/services/chatRecordingService.ts): file name, append-only writes, token attachment, rewind, old-format migration.
- [gemini-cli @2fe7c2d, `geminiChat.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/core/geminiChat.ts): usageMetadata buffering, model selection.
- [gemini-cli @2fe7c2d, `storage.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/config/storage.ts), [`paths.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/utils/paths.ts), [`storageMigration.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/core/src/config/storageMigration.ts): directories, `GEMINI_CLI_HOME`, the hash-to-slug copy.
- [gemini-cli @2fe7c2d, `settingsSchema.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/cli/src/config/settingsSchema.ts), [`sessionCleanup.ts`](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/packages/cli/src/utils/sessionCleanup.ts): retention.
- [gemini-cli docs, Session management](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/docs/cli/session-management.md), [Configuration reference](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f065dc40ad573d50b2091116f8a4aa18/docs/reference/configuration.md).
- Commits: [b5dd6f9](https://github.com/google-gemini/gemini-cli/commit/b5dd6f9ea) (recording wired into GeminiChat, v0.4.0), [974ab66](https://github.com/google-gemini/gemini-cli/commit/974ab66b7) (retention, v0.9.0), [4e1b3b5](https://github.com/google-gemini/gemini-cli/commit/4e1b3b5f5) (v0.30.0), [06ddfa5](https://github.com/google-gemini/gemini-cli/commit/06ddfa5c4) (v0.33.0), [104587b](https://github.com/google-gemini/gemini-cli/commit/104587bae) (subagent directories, v0.37.0), [f744913](https://github.com/google-gemini/gemini-cli/commit/f74491358) (JSONL, v0.39.0), [f47d6c6](https://github.com/google-gemini/gemini-cli/commit/f47d6c6f7) (failed-attempt buffering, v0.55.0).
- [`@google/genai` `types.ts`](https://github.com/googleapis/js-genai/blob/main/src/types.ts) and [Gemini API UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata): field meanings.
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Context caching](https://ai.google.dev/gemini-api/docs/caching).
- [ccusage Gemini adapter @32ef434](https://github.com/ryoppippi/ccusage/tree/32ef4346fc9d0d757a544cef5a04975884e4b773/rust/adapters/gemini), [ccusage Gemini guide](https://ccusage.com/guide/gemini/).
- [tokscale Gemini parser @1d9a939](https://github.com/junhoyeo/tokscale/blob/1d9a9395418efc6952944b794097935d7d6fa1e8/crates/tokscale-core/src/sessions/gemini.rs).
