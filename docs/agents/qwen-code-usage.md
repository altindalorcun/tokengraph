# Qwen Code local token usage data

This note explains where, and in what format, Qwen Code (`QwenLM/qwen-code`, npm `@qwen-code/qwen-code`, a
fork of Gemini CLI) stores per-request token usage in its local files, and how to normalise it into
tokengraph's fields. The adapter lives in `packages/cli/src/adapters/qwen-code/`; this note is the research
behind it. Qwen Code was not installed on the machine where the research was done. Everything below was worked
out from the source (main, commit [`e584d4d`](https://github.com/QwenLM/qwen-code/tree/e584d4d1973ad2b40278e67a945eb62c0006baaa),
18 October 2026, package version 0.25.2) and every field name was re-checked against that code; it was not
verified against a real local file.

In short: Qwen Code writes one JSON line per chat record into `~/.qwen/projects/<cwd>/chats/<sessionId>.jsonl`.
A `type: "assistant"` record carries one API response in a Gemini-shaped `usageMetadata` object. It is close to
the [Gemini CLI](gemini-cli-usage.md) adapter's case, with four differences that matter: the usage object has
the Gemini **API** field names (not Gemini CLI's `tokens`), `promptTokenCount` already includes cache reads
**and, on the Anthropic protocol, cache creation**, the dedup key is a per-record `uuid` that `/branch` copies
into other files, and background subagents write their own transcripts in a separate folder with no `model`
field. Chat transcripts are never auto-deleted; background subagent transcripts are, after 30 days by default.

These counters are local session token usage, not a provider bill or quota report.

## Local data location

- Qwen home: `$QWEN_HOME` when set (the `.qwen` folder itself, not its parent as with `GEMINI_CLI_HOME`),
  otherwise `~/.qwen` (`os.homedir()`; the same relative path on macOS, Linux and Windows). Leading `~` and
  relative values are resolved. Falls back to `os.tmpdir()/.qwen` when there is no home directory
  ([storage.ts#L172-L201](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/config/storage.ts#L172-L201)).
- Runtime dir: `$QWEN_RUNTIME_DIR` when set, else a runtime dir given in settings, else the Qwen home. The
  adapter follows the environment variable and also keeps reading `<Qwen home>/projects`; a runtime dir set
  only in `settings.json` is not followed (a sync cannot see it).
- Project folder: `<runtime dir>/projects/<sanitizedCwd>/`, where `<sanitizedCwd>` is the project root with every
  non-alphanumeric character replaced by `-` (lowercased on Windows)
  ([paths.ts#L388-L392](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/utils/paths.ts#L388-L392)).
  The name encodes a project path, so the adapter never stores it.
- Chats: `<project folder>/chats/<sessionId>.jsonl` (`ensureChatsDir`, `ensureConversationFile` in
  [chatRecordingService.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/services/chatRecordingService.ts)).
  The sibling `<sessionId>.runtime.json` holds no usage and is not read. (A doc comment in the service still says
  `~/.qwen/tmp/<project_id>/chats/`; the code and `getProjectDir()` say `projects`.)
- Background subagents: `<project folder>/subagents/<sessionId>/agent-<agentId>.jsonl`, next to
  `agent-<agentId>.meta.json` and a transient `agent-<agentId>.jsonl.stream`
  ([agent-transcript.ts#L8-L20](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/agents/agent-transcript.ts#L8-L20)).
  Those requests are not in the parent chat file, so the adapter reads both trees: every `*.jsonl` under
  `chats/` and under `subagents/` (the `.stream` and `.meta.json` files do not match).
- `~/.qwen/tmp/<hash>/` (checkpoints, tool results) holds no token data and is not read.
- Recording switch: `general.chatRecording` (default `true`). When it is off there is no data at all.

## Record shape

A line is a `ChatRecord`
([chatRecordingService.ts#L354-L471](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/services/chatRecordingService.ts#L354-L471)).
The fields the adapter reads, and nothing else: `type`, `uuid`, `timestamp` (ISO 8601), `model`,
`usageMetadata`. Message text (`message`), tool output, `cwd` and the rest of the record are never read into
anything that is kept. Only `type: "assistant"` records carry request usage (`recordAssistantTurn`, called only
from `core/llm-chat.ts`, once per API response). Record types `user`, `tool_result` and `system` are ignored; in
particular `system` / `ui_telemetry` embeds a second copy of the same token counts and would double count.

```json
{"uuid":"9f1c…","parentUuid":"4be2…","sessionId":"c0a8…","timestamp":"2026-10-17T10:00:00.000Z","type":"assistant",
 "model":"qwen3-coder-plus","message":{"role":"model","parts":[…]},
 "usageMetadata":{"promptTokenCount":12000,"candidatesTokenCount":300,"cachedContentTokenCount":9000,
                  "thoughtsTokenCount":40,"totalTokenCount":12300}}
```

(The numbers are made up.) The writer can have produced two records glued on one line as `}{`
([#3656](https://github.com/QwenLM/qwen-code/pull/3656)); the reader splits such a line into its top-level
objects (braces inside strings do not count) instead of dropping it. A line that does not parse at all (a
partial write) is skipped silently.

A subagent transcript record is the same shape (`baseFields('assistant')` plus `usageMetadata`) but has **no
`model`** (`onRoundText`, agent-transcript.ts#L775-L800). Records with `usageMetadata` omitted (text without a
usage chunk) are not requests and are ignored.

## Semantics of `usageMetadata`

Qwen Code speaks three wire protocols and normalises all of them into the Gemini `usageMetadata` shape. The
record does not say which protocol produced it.

| Protocol | `promptTokenCount` | `candidatesTokenCount` | `cachedContentTokenCount` | `thoughtsTokenCount` |
| --- | --- | --- | --- | --- |
| OpenAI-compatible, Qwen OAuth ([converter.ts#L1478-L1530](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/core/openaiContentGenerator/converter.ts#L1478-L1530)) | `prompt_tokens` (includes cached) | `completion_tokens` (includes reasoning) | `cached_tokens`, else 0 | provider's `reasoning_tokens`, or an **estimate from the reasoning text** |
| Anthropic ([usage.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/core/anthropicContentGenerator/usage.ts)) | `input + cache_read + cache_creation` | `output_tokens` | `cache_read` | absent |
| Gemini native | raw Gemini semantics | **excludes** thoughts | cached | thoughts |

The OpenAI path may omit `promptTokenCount` and `candidatesTokenCount` (only `totalTokenCount` is set) when a
provider reports no breakdown; such a record cannot be split and is skipped as malformed.

Usage is per request, not cumulative: the stream loop keeps the last chunk's `usageMetadata` and writes one
assistant record per API response.

## Mapping to tokengraph fields

| tokengraph | Qwen Code |
| --- | --- |
| `cache_read` | `cachedContentTokenCount` |
| `input` | `max(0, promptTokenCount - cachedContentTokenCount)` |
| `output` | `max(candidatesTokenCount, totalTokenCount - promptTokenCount)` |
| `cache_creation` | 0 (not recorded separately) |
| 5m / 1h split | `null` (unknown) |

- Output uses `total - prompt` so that a Gemini-native response, where thoughts sit outside
  `candidatesTokenCount`, still counts them, while on the other two protocols `total - prompt` equals
  `candidates`. `thoughtsTokenCount` is never added on top (it is a subset on two protocols and an estimate on
  one). A missing candidates or total counts as 0.
- **Cache creation is folded into `promptTokenCount`** on the Anthropic protocol, and the separate figure is held
  in memory only (a `WeakMap`), never written to disk. It therefore lands in `input`. The weighted-token total is
  unchanged (cache creation weighs 1.0 like input), but the cache-write figure is 0 and a cost estimate prices
  those tokens at the input rate rather than the cache-write rate, so cost for Claude models run through Qwen
  Code is slightly low.
- `cachedContentTokenCount` above `promptTokenCount` is clamped to 0 fresh input and reported once per uuid.
- Pricing tier follows the usual rules; no Qwen model has a rate in `pricing.ts`, so Qwen cost is unknown and
  stays unpriced. Claude or GPT models used through Qwen Code are priced as elsewhere.

### Where Qwen Code differs from the Gemini CLI adapter

Shared code: the field readers (`usage-fields.ts`), the tentative per-id diagnostics for copies
(`record-diagnostics.ts`), `RequestBuckets`, JSONL streaming and directory walking. The Gemini CLI adapter uses
the same ones and its tests pass unchanged. The semantics that differ are therefore only these:

| | Gemini CLI | Qwen Code |
| --- | --- | --- |
| Record | `type: "gemini"` with `tokens: {input, output, cached, thoughts, tool, total}` | `type: "assistant"` with `usageMetadata: {promptTokenCount, ...}` |
| Fresh input | `input - cached`, plus `tool` | `promptTokenCount - cachedContentTokenCount`; cache creation is inside it |
| Output | `output + thoughts` | `max(candidates, total - prompt)`; thoughts never added |
| Dedup key | message `id` | record `uuid` |
| Copies | hash to slug directory copy, `.json` to `.jsonl` migration, `$set.messages` checkpoints | `/branch` fork files |
| Other files | `chats/<session>/` subagent sessions carry the same format | `subagents/` transcripts with no `model`, resolved from `agent-<id>.meta.json` |
| Legacy format | single `.json` document | none (the JSONL tree is the only format) |
| Line damage | partial line skipped | glued `}{` records split, partial line skipped |
| Retention | all sessions after 30 days | only subagent transcripts after 30 days |

## Dedup unit and traps

- Key: `uuid` (a random UUID per record). It is global across files: the request is counted once, at its most
  complete copy (per-field max, first copy's date and model win).
- **`/branch` forks** ([sessionService.ts, `forkSession`](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/services/sessionService.ts#L4016))
  rewrite every retained record into a new session file as `{...record, sessionId: new, parentUuid: rebuilt,
  forkedFrom: {sessionId, messageUuid}}`: the same `uuid` and the same `usageMetadata`. Counting by line would
  count each forked request twice; the cross-file `uuid` key counts it once.
- `/rewind` re-roots `parentUuid` and leaves the rewound records in the file. Their usage was really spent, so
  they are counted; the branch tree is not rebuilt.
- `system` / `ui_telemetry` duplicates usage and is skipped (only `assistant` records count).
- A failed stream attempt with a partial tool-use record is dropped on retry success, so failed attempts are not
  on disk and their usage is invisible.
- Subagent transcripts are separate requests, not copies of the parent's.
- Side LLM calls (title generation, compression and so on) were not seen being recorded as assistant records,
  so totals are a lower bound, never an overcount.
- A record without a `uuid`, with an invalid timestamp, or with a missing or invalid `promptTokenCount` (or a
  present but negative or fractional counter) is skipped and reported; a valid copy of the same `uuid` in
  another file clears the report for it.

## Model attribution

Main-chat records carry the configured model id in `model` (`recordAssistantTurn({model})`): a free-form string
such as `qwen3-coder-plus`, or whatever a custom OpenAI-compatible endpoint is called, without a provider
prefix. The adapter stores it through `canonicalModelId`, which strips only a documented gateway prefix and
leaves everything else as written. Provider and auth type are not on assistant records.

Subagent transcript records have no `model`. The `agent-<id>.meta.json` sidecar names it: `model` for a
background launch (`writeAgentMeta` in `tools/agent/agent.ts`), or `persistedCliFlags.model` for a foreground
one. The adapter reads only those two fields from the sidecar (its description and tool lists are never kept). A
subagent record with neither is stored under `unknown`, never guessed.

## Retention and deletion

The earlier research note said Qwen Code never deletes chats; that is right for `chats/`, but
`general.cleanupPeriodDays` (default **30**, `0` means about one hour) also sweeps
`<project folder>/subagents/<sessionId>/` folders whose modification time is older than the cutoff
([cleanup.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/cli/src/utils/housekeeping/cleanup.ts),
[scheduler.ts#L474-L548](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/cli/src/services/housekeeping/scheduler.ts#L474-L548)).
The sweep runs at most once a day, from interactive sessions. The same setting covers `~/.qwen/file-history/`
and the runtime `debug/` folder, which hold no token data. Users can also delete a session from the session UI.

`tokengraph status` therefore reports a `qwen-code` policy (setting `general.cleanupPeriodDays` in
`<Qwen home>/settings.json`, read at the user level only, not a project's `.qwen/settings.json`): default 30
days, an explicit number, 0 or negative as the one-hour minimum, anything unreadable as unknown. Its warning
says "background subagent logs", because chat usage is not at risk. Ledger max-merge keeps already synced
subagent usage.

## Format history

The `uuid` / `parentUuid` JSONL tree is the current format; the chat-recording toggle landed in 0.5.1 and the
package is at 0.25.2. The shape has been stable for many releases, but only the current source was read: the
pre-JSONL Gemini-fork era (0.0.x) layout was not checked, and a newer "managed" execution engine
(`services/session-execution-engine.ts`) that writes into the same `<sessionId>.jsonl` and keeps
`usageMetadata` was not read beyond that.

## Not verified against real data

- Qwen Code was not installed and no real transcript was seen. The record shape, the protocol mappings and the
  paths come from the source at the commit above; the example figures are invented.
- Which protocol produced a record is not recorded, so `total - prompt` for output and the cache clamp are rules
  that fit all three protocols in the code, not something checked on real files per protocol.
- `thoughtsTokenCount` may be an estimate; it is not used.
- A foreground subagent's transcript location and sidecar model were read from `agent.ts` only. Whether every
  Qwen Code release writes the sidecar `model` is not known; a missing one gives an `unknown` model.
- The glued `}{` records come from a changelog line; whether older files contain them is unknown.
- A runtime dir set only in `settings.json`, and a project-level `cleanupPeriodDays`, are not followed.
- Tokscale's Qwen parser (`sessions/qwen.rs`) was used only as a cross-check: it keys dedup by line index and
  adds cached tokens on top of the prompt, which double counts cache and fork copies. Its arithmetic is not used.

## Sources

- [storage.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/config/storage.ts) (Qwen home, runtime dir, project dir)
- [chatRecordingService.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/services/chatRecordingService.ts) (`ChatRecord`, `recordAssistantTurn`)
- [llm-chat.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/core/llm-chat.ts) (one assistant record per response)
- [openaiContentGenerator/converter.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/core/openaiContentGenerator/converter.ts), [anthropicContentGenerator/usage.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/core/anthropicContentGenerator/usage.ts)
- [agents/agent-transcript.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/agents/agent-transcript.ts), [tools/agent/agent.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/tools/agent/agent.ts) (subagent transcripts and sidecar)
- [sessionService.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/core/src/services/sessionService.ts) (`forkSession`)
- [housekeeping/cleanup.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/cli/src/utils/housekeeping/cleanup.ts), [settingsSchema.ts](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/packages/cli/src/config/settingsSchema.ts) (`general.cleanupPeriodDays`)
- [settings.md](https://github.com/QwenLM/qwen-code/blob/e584d4d1973ad2b40278e67a945eb62c0006baaa/docs/users/configuration/settings.md) (`general.chatRecording`)
