# Cline local token usage data

This note researches how we can read per-request token usage from the local files of Cline (the
VS Code extension `saoudrizwan.claude-dev` and the Cline CLI). The adapter lives in
`packages/cli/src/adapters/cline/`; this document collects the format, the traps and the
recommended normalisation that were checked against the source code before the adapter was
written. All claims were read from Cline's source code (the commits below); Cline was not
installed on the research machine then. Since then Cline 3.0.73 has been run against a fake LLM server
(see "Checked against real runs"); other versions and the editor extension's classic files were not run.

Sources examined:

- `cline/cline` `main`: `252082b9e93b4f91253876391e35b4c13326f5e6` (26 September 2026;
  extension 4.1.21, CLI 3.0.65, SDK 0.0.86+).
- `cline/cline` `v3.89.2`: `e1bdeeff68e95734901c7a4b3a31753bae54a634` (the last "classic"
  extension code before the SDK).
- `cline/cline` `legacy-extension` branch: `7761370240ffce9e3890cb56f6c51655f3f5b0a7` (the
  "legacy" bundle inside the VSIX published today, version 4.0.12 code).
- For older versions, individual files at the tags `v3.10.0` ... `v3.80.0`.
- `junhoyeo/tokscale`: `1d9a9395418efc6952944b794097935d7d6fa1e8` (cross-check).

## The most important finding: TWO separate formats live side by side today

With 4.0.0 the extension moved to a new "SDK"-based runtime, which was reverted in 4.0.1. The VSIX
published since 4.1.0 is an **A/B bundle**: it contains both `legacy/` (the old code, the
`legacy-extension` branch) and `next/` (the SDK code), and a loader enables one of them for each
window according to a PostHog flag (`ext-sdk-bundle-rollout`, a percentage). Most users are still
on the legacy bundle and a small percentage on the SDK bundle; if the flag is withdrawn, the user
goes back to legacy ([`apps/vscode-rollout/README.md`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/vscode-rollout/README.md),
[`CHANGELOG.md` 4.1.0 / 4.0.1 / 4.0.0](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/CHANGELOG.md)).
The new Cline CLI (3.x, `apps/cli`) writes only the SDK format.

| Format | Written by | Location | Usage record |
| --- | --- | --- | --- |
| **A. Classic task** | Extension <=3.89.x, 4.0.1-4.0.12, the legacy bundle of 4.1.x; the old Cline CLI / JetBrains / standalone | `<globalStorage>/tasks/<taskId>/ui_messages.json` | the `text` JSON of `say: "api_req_started"` lines |
| **B. SDK session** | Extension 4.0.0 and the `next` bundle of 4.1.x, Cline CLI 3.x, the desktop app | `~/.cline/data/sessions/<sessionId>/<sessionId>.messages.json` | `metrics` on assistant messages |

The adapter must read both; the two are described separately below, along with the double-counting
traps between them. In the two formats **the meaning of `tokensIn`/`inputTokens` is opposite**: in
A it mostly excludes cache (varying by provider), in B it always includes cache.

## Local data location

### A. Classic tasks

In the VS Code extension the root is VS Code's `ExtensionContext.globalStorageUri`:
`<user data dir>/User/globalStorage/saoudrizwan.claude-dev/`. Under it
([`disk.ts`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/storage/disk.ts)):

```text
saoudrizwan.claude-dev/
  state/taskHistory.json               # task list (HistoryItem[]), per-task totals
  tasks/<taskId>/ui_messages.json      # per-request usage is HERE
  tasks/<taskId>/api_conversation_history.json
  tasks/<taskId>/task_metadata.json    # model_usage timeline (3.12+)
  tasks/<taskId>/context_history.json
  checkpoints/ ...
```

Very old tasks may have `claude_messages.json` instead of `ui_messages.json` (disk.ts renames it
when it reads). `<taskId>` is a string derived from the millisecond epoch.

`<user data dir>` is VS Code's standard convention (not in the Cline source):

| OS | VS Code | Other hosts (same pattern, the directory name changes) |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev` | `Code - Insiders`, `Cursor`, `VSCodium`, `Windsurf` |
| Linux | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev` | same names |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev` | same names |
| Remote (SSH/WSL/Codespaces) | `~/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev` | `~/.vscode-server-insiders/…`, `~/.cursor-server/…` |

In the old Cline CLI (1.x/2.x), JetBrains and the "standalone" host, `globalStorageUri` is
`$CLINE_DIR/data` (default `~/.cline/data`), so the same structure sits under
`~/.cline/data/tasks/<taskId>/` and `~/.cline/data/state/taskHistory.json`
([`standalone/vscode-context.ts`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/standalone/vscode-context.ts)).
Today's SDK bundle also reads old tasks from exactly these two roots: `~/.cline/data` and the VS
Code `globalStorageUri`
([`sdk-task-history.ts` `getLegacyDataDirs`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/vscode/src/sdk/sdk-task-history.ts#L215),
[`legacy-state-reader.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/vscode/src/sdk/legacy-state-reader.ts)).
The migration that moves VS Code global state to `~/.cline/data` deliberately does not move
`taskHistory` and `tasks/` ([`vscode-to-file-migration.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/vscode/src/hosts/vscode/vscode-to-file-migration.ts)).

Recommendation for the adapter: read only `tasks/*/ui_messages.json` (+ `task_metadata.json` for
the model); the root list = the host × OS directories above +
`${CLINE_DATA_DIR:-${CLINE_DIR:-~/.cline}/data}`. `api_conversation_history.json` is needed for
one exception only (see "Migration to B" below), and even there only for the message
count/position; its content must not be read.

### B. SDK sessions

Root resolution ([`sdk/packages/shared/src/storage/paths.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/shared/src/storage/paths.ts#L179)):

```text
CLINE_SESSION_DATA_DIR
  || (CLINE_DATA_DIR || (CLINE_DIR || ~/.cline) + "/data") + "/sessions"
```

Directory structure ([`session-artifacts.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/services/session-artifacts.ts),
[`docs/messages-contract-v1.md`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/docs/messages-contract-v1.md)):

```text
~/.cline/data/sessions/<sessionId>/
  <sessionId>.json                       # manifest: provider, model, metadata (importedFrom, legacyTask, fork…)
  <sessionId>.messages.json              # main agent messages + metrics
  <agentId>.messages.json                # sub-agent (subagent) messages
  <agentId>__<teamTaskId>.messages.json  # team task messages
  <sessionId>.compaction.json            # compacted working context (not read for usage)
  hooks.jsonl                            # observation/debug
~/.cline/data/db/sessions.db             # SQLite index (no need to read)
```

The `<sessionId>` format is `<startedAtMs>_<nanoid>`. The VS Code SDK bundle uses the same
`~/.cline/data/sessions` as the CLI (the hub daemon is shared). The CLI's `--config <dir>` flag
and sandbox mode (`CLINE_SANDBOX_DATA_DIR`) can move the root elsewhere
([`apps/cli/src/main.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/cli/src/main.ts#L150),
[`helpers.ts` `configureSandboxEnvironment`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/cli/src/utils/helpers.ts#L583));
those cannot be found by the default scan. The adapter reads `sessions/*/*.messages.json` and the
`<sessionId>.json` manifest in the same directory; `providers.json`, `secrets.json` and
`globalState.json` must never be opened (the API keys are there).

## A. The `ui_messages.json` schema

The file is a single JSON array (`ClineMessage[]`), and the whole file is rewritten on every
record. The line that carries usage:

```json
{
  "ts": 1758900000123,
  "type": "say",
  "say": "api_req_started",
  "text": "{\"request\":\"<task>…</task>…\",\"tokensIn\":812,\"tokensOut\":356,\"cacheWrites\":2104,\"cacheReads\":48211,\"cost\":0.0412}",
  "modelInfo": { "providerId": "anthropic", "modelId": "claude-sonnet-4-5-20250929", "mode": "act" },
  "conversationHistoryIndex": 7
}
```

The JSON inside `text` (`ClineApiReqInfo`,
[`ExtensionMessage.ts#L345`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/shared/ExtensionMessage.ts#L345)):

| Field | Meaning |
| --- | --- |
| `request` | The user content of the request (markdown). **Prompt text: never kept, it does not even need to be read.** |
| `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads` | The **sum** (`+=`) of that request's `usage` chunks from the provider |
| `cost` | USD, computed by Cline or reported by the provider |
| `cancelReason` | `"user_cancelled"` / `"streaming_failed"`; the usage of a partial stream is still written |
| `streamingFailedMessage`, `retryStatus` | Error/retry information; `retryStatus` is removed when the request finishes |

The write flow ([`task/index.ts` v3.89.2](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/task/index.ts#L2843),
[`task/utils.ts#L28`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/task/utils.ts#L28)):

1. Before the request, `say("api_req_started", {request: "…Loading..."})`: `ts` is this moment
   (the **start** time of the request) and never changes again.
2. During the stream each `usage` chunk is **added** to `taskMetrics` and the same line is updated
   in place with `updateApiReqMsg` (`ts` is kept).
3. At the end of the stream (or on cancel/error) the line is finalised with the last values; for
   the OpenRouter/Cline provider, if no usage arrives during the stream, it is filled in later
   with `getApiStreamUsage()`.

Other relevant `say` types:

- `deleted_api_reqs`: when a checkpoint is restored ("restore task"), the **total** of the deleted
  `api_req_started` lines is written as a single line; `ts` is the moment of the restore and there
  is no model ([`checkpoints/index.ts#L694`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/integrations/checkpoints/index.ts#L694)).
- `subagent_usage`: the total of a group of sub-agents (`{source:"subagents", tokensIn, …}`);
  sub-agents have no `api_req_started` lines of their own
  ([`SubagentToolHandler.ts`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/task/tools/handlers/SubagentToolHandler.ts)).
  A sub-agent's model can differ from the parent task's (`SubagentBuilder.applyModelOverride`).
- `api_req_finished`: very old versions; `combineApiRequests` merges it into `api_req_started`; it
  is not written today.

Cline's own task total (`getApiMetrics`) sums `api_req_started` + `deleted_api_reqs` +
`subagent_usage`
([`getApiMetrics.ts`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/shared/getApiMetrics.ts)).

### A: where is the model?

| Version | Per-request model source |
| --- | --- |
| **>= 3.37.0** | The line's own `modelInfo.{providerId, modelId, mode}`. `say()` writes the current provider/model on every message ([`task/index.ts` `say`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/task/index.ts#L826)). Absent in v3.36.0, present in v3.37.0 (by binary search over the tags). |
| 3.12.0 - 3.36.x | `task_metadata.json` → `model_usage: [{ts, model_id, model_provider_id, mode}]`. `recordModelUsage` is called before every request and appends only when something changed ([`ModelContextTracker.ts#L10`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/context/context-tracking/ModelContextTracker.ts#L10)). The request's model = the last entry with `ts <= api_req.ts`. Absent in v3.11.0, present in v3.12.0. |
| < 3.12.0 | No per-request model. `taskHistory.json` → `modelId` is the last model per task, unreliable. **`unknown` must be used.** |

The assistant messages in `api_conversation_history.json` also have `modelInfo` and
`metrics.tokens`, but their `ts` values are request end times and the message identity/matching
is weak; it is not recommended as a primary source. tokscale's old approach (the `<model>` tag
inside `<environment_details>`) is no longer written in Cline 4.x ([tokscale #1321](https://github.com/junhoyeo/tokscale/issues/1321)).

### A: does `tokensIn` include cache? It varies by provider

In the classic code each provider produces its own `usage` chunk and the convention is
inconsistent. Cline's own cost code admits it: `calculateApiCostAnthropic` assumes input excludes
cache, `calculateApiCostOpenAI` assumes it includes cache
([`utils/cost.ts`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/utils/cost.ts)).
From the v3.89.2 / `legacy-extension` provider files
([`core/api/providers/`](https://github.com/cline/cline/tree/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/api/providers)):

**Separate (tokensIn = uncached input only):**

| providerId | Source expression |
| --- | --- |
| `anthropic`, `vertex`, `minimax`, `aihubmix` (Anthropic path) | `input_tokens`; `cache_creation_input_tokens` → cacheWrites, `cache_read_input_tokens` → cacheReads (already separate in the Anthropic API). `message_start` sends input and `message_delta` sends output; they are summed. |
| `bedrock` (Converse, Claude etc.) | `metadata.usage.inputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens` (separate in AWS Converse) |
| `openrouter`, `cline`, `vercel-ai-gateway` | `prompt_tokens − cached_tokens − cache_write_tokens` |
| `gemini` | `promptTokenCount − cachedContentTokenCount` (>=3.20; 3.10 has no cache field) |
| `openai-native`, `groq`, `moonshot` | `prompt_tokens − cached_tokens` |
| `deepseek` | `max(0, prompt − hit − miss)` (= 0); `prompt_cache_miss_tokens` → cacheWrites, hit → cacheReads |

**Included (tokensIn = `prompt_tokens`, the cache subsets are inside it):**

| providerId | cacheReads | cacheWrites |
| --- | --- | --- |
| `openai` ("OpenAI Compatible"), `xai`, `hicap` | `prompt_tokens_details.cached_tokens` | `prompt_cache_miss_tokens` (DeepSeek style; actually uncached input) |
| `fireworks`, `doubao`, `qwen` | `prompt_cache_hit_tokens` / `cached_tokens` | `prompt_cache_miss_tokens` |
| `litellm`, `oca` | `cache_read_input_tokens` / `prompt_cache_hit_tokens` | `cache_creation_input_tokens` / `prompt_cache_miss_tokens` |
| `requesty` | `cached_tokens` | `caching_tokens` |
| `lmstudio`, `zai` | `cached_tokens` | 0 |
| `openai-codex` | Responses API `cached_tokens` | `cache_creation_input_tokens` / `cache_write_tokens` |

**No cache field at all (tokensIn = prompt, cacheReads/Writes 0):** `ollama`
(`prompt_eval_count`), `mistral`, `together`, `nebius`, `sambanova`, `cerebras`, `baseten`,
`wandb`, `nousresearch`, `huawei-cloud-maas`, `qwen-code`, `sapaicore`, `dify`, `asksage`,
`huggingface`, `vscode-lm`. There is no double-counting risk for these (cache reads look like
"fresh" input; the weighted total comes out slightly high, but the information is not in this
source anyway).

Version history (sampled at 3.10 / 3.20 / 3.40 / 3.89): `anthropic` has always been separate and
`openai` has always been included; `openrouter` gave no cache fields in 3.10, extracted the read
in 3.40, and extracts read+write in 3.89. No version double-counts.

### A: recommended normalisation

The `providerId` (from the line for >=3.37, from `model_usage` for 3.12-3.36) falls into one of
two sets:

| Set | `inputTokens` | `cacheCreationTokens` | `cacheReadTokens` | `outputTokens` |
| --- | --- | --- | --- | --- |
| Separate | `tokensIn` | `cacheWrites` | `cacheReads` | `tokensOut` |
| Included / no cache | `max(0, tokensIn − cacheReads − cacheWrites)` | `cacheWrites` | `cacheReads` | `tokensOut` |

- The "included" formula is the same as Cline's own `calculateApiCostOpenAI` and the DeepSeek
  handler. `prompt_cache_miss_tokens` is really uncached input and not a cache write; putting it
  in `cacheCreationTokens` does **not change** the weighted total (both have weight 1.0), it only
  affects the cost label. The models of these providers will already be unpriced (unknown) in
  `pricing.ts`, so there is no practical difference.
- For providers with no cache field the two formulas give the same result (0 is subtracted), so
  the safe default for an unknown/new `providerId` is the "included" formula: it **never double
  counts**, and at worst, for a separate provider where `tokensIn < cacheReads + cacheWrites`, it
  clamps fresh input to 0 (an undercount). So the separate set must be an explicit allow-list.
- If the `providerId` is unknown (< 3.12), the "included" formula applies and the model is
  `unknown`.
- The 5 minute / 1 hour cache-write split is written by no provider, so
  `cacheCreation5mTokens` / `cacheCreation1hTokens` = `null`.
- `tokensOut`: includes thinking on Anthropic; on OpenAI derivatives `completion_tokens` includes
  reasoning. There is nothing extra to add.

### A: what must be skipped or handled specially

- **`providerId === "claude-code"`: skip.** This provider runs the Claude Code CLI as a
  subprocess; that usage is also written to `~/.claude/projects/**/*.jsonl` and tokengraph's
  `claude-code` adapter already counts it. Also, the handler **overwrites** the usage (`=`) on
  every assistant message, so in a multi-step call only the last message's usage remains, which
  is incomplete anyway ([`claude-code.ts#L42`](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/api/providers/claude-code.ts#L42)).
  `openai-codex`, on the other hand, goes straight to `chatgpt.com/backend-api/codex` and
  produces no Codex CLI rollout file, so it can be counted.
- **`deleted_api_reqs`: skip.** The total of the deleted requests is written to the day of the
  restore and without a model. If an earlier sync saw the original lines, the `max()` merge in
  the ledger already preserves them; counting this line would add the same tokens a second time
  (to the wrong day). Deleted requests that were never synced are lost, an accepted undercount.
- **`subagent_usage`: count it, model `unknown`.** It is recorded nowhere else; but since the
  sub-agent model can be overridden, the `modelInfo` on the line (the parent task's model) is
  unreliable. Normalise with the line's `providerId` (a sub-agent uses the same provider
  configuration, only the model id can change). `ts` = the end of the group.
- **Non-Claude models on Bedrock** (the DeepSeek R1 path and so on): usage is **estimated** from
  text length, and on the R1 path both the intermediate chunks and the final total are sent and
  summed with `+=`, so output and input are inflated about 2×
  ([`bedrock.ts` ~L410-516](https://github.com/cline/cline/blob/e1bdeeff68e95734901c7a4b3a31753bae54a634/apps/vscode/src/core/api/providers/bedrock.ts#L409)).
  Under the "nothing is guessed" rule, `bedrock` + non-Anthropic model ids should be skipped, or
  at least flagged separately.
- **The old `openai` (OpenAI Compatible) handler** yielded every chunk that contained `usage`;
  with servers that send cumulative usage in every chunk, `+=` inflates it. In the
  `legacy-extension` branch it was fixed to use only the last usage
  ([diff: `latestUsage`](https://github.com/cline/cline/blob/7761370240ffce9e3890cb56f6c51655f3f5b0a7/apps/vscode/src/core/api/providers/openai.ts)).
  It cannot be detected in old files; a known risk.
- An `api_req_started` whose totals are all zero (no usage arrived, an error) is skipped. Lines
  with `cancelReason` are counted: they are tokens that were really consumed in a partial stream
  (on Anthropic the input arrives in `message_start`).

## B. The `<sessionId>.messages.json` schema

The official contract: [`messages-contract-v1.md`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/docs/messages-contract-v1.md)
(example: [`fixtures/messages/success.messages.json`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/fixtures/messages/success.messages.json)).

```json
{
  "version": 1,
  "updated_at": "2026-09-26T10:12:03.511Z",
  "agent": "lead",
  "sessionId": "1758881523000_a1b2c",
  "origin": { "source": "cli", "mode": "user", "sessionId": "1758881523000_a1b2c" },
  "messages": [
    { "id": "msg_user_1", "role": "user", "content": [ { "type": "text", "text": "…" } ] },
    {
      "id": "msg_mfx3k2_7",
      "role": "assistant",
      "ts": 1758881531456,
      "modelInfo": { "id": "claude-sonnet-4-6", "provider": "anthropic", "family": "claude-sonnet-4" },
      "metrics": {
        "inputTokens": 52310,
        "outputTokens": 412,
        "cacheReadTokens": 48211,
        "cacheWriteTokens": 3287,
        "cost": 0.0412
      },
      "content": [ { "type": "text", "text": "…" } ]
    }
  ]
}
```

- `metrics`: the **difference** of the cumulative usage taken before and after each model call in
  the agent loop, that is, the usage of one model request
  ([`agent-runtime.ts` `usageDelta`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/agents/src/agent-runtime.ts#L428),
  [L1980](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/agents/src/agent-runtime.ts#L1980)).
  The contract says "the last assistant message of the turn carries it"; the code stamps it per
  request. Either way, summing all `metrics` is right. Empty-response retries (the retry
  middleware) add the usage of discarded attempts to the accepted response, and these are real
  billed tokens
  ([`retry-empty-response.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/llms/src/providers/middleware/retry-empty-response.ts#L230)).
  If a turn fails without producing any assistant output, no message is added.
- `modelInfo.{id, provider}`: **per request**, the model that made the request itself
  (`config.messageModelInfo`); if missing it is filled with the session result's model
  ([`session-data.ts` `withLatestAssistantTurnMetadata`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/services/session-data.ts)).
- `ts`: the message's `createdAt` (when the stream ends), in ms epoch
  ([`agent-message-codec.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/runtime/config/agent-message-codec.ts#L123)).
  If it is missing (an old or imported message) the message should not be counted or should fall
  back to the manifest time; recommendation: skip.
- `id`: `createUID("msg")`, persistent; `nanoid()` is generated at write time only if it is
  missing.

### B: `inputTokens` usually includes cache, but not for every model

The SDK calls providers through the AI SDK, and `normalizeUsage` takes `inputTokens` from the AI
SDK's `inputTokens.total` (or from `prompt_tokens`/`promptTokenCount`): **the full request size,
cache reads/writes included**
([`ai-sdk.ts` `normalizeUsage` L1184](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/llms/src/providers/ai-sdk.ts#L1184)).
The tests pin this down (OpenRouter: `inputTokens 9096`, `cacheReadTokens 9090`; AI SDK v3
shape: `total 4605 = noCache 1000 + cacheRead 3605`)
([`ai-sdk.test.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/llms/src/providers/ai-sdk.test.ts)).
Cline's code says so explicitly in three places and converts to the classic separate buckets with
the following formula:
[`usage.ts` `getCurrentContextSize`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/services/usage.ts),
[`agent-events.ts` `legacyTokenUsageFromUsageEvent`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/services/agent-events.ts#L122),
[`message-translator.ts` `normalizeUsageEvent`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/vscode/src/sdk/message-translator.ts#L87).

| SDK `metrics` field | tokengraph field |
| --- | --- |
| `inputTokens − cacheReadTokens − cacheWriteTokens` (inclusive row), or `inputTokens` as is (exclusive row, see below) | `inputTokens` |
| `outputTokens` | `outputTokens` (reasoning note below) |
| `cacheWriteTokens` | `cacheCreationTokens` |
| `cacheReadTokens` | `cacheReadTokens` |
| no TTL split | `cacheCreation5mTokens` / `cacheCreation1hTokens` = `null` |

Cline's own code clamps with `max(0, …)`; tokengraph does not clamp (see below).

#### B: exclusive rows behind the Cline gateway

The "includes cache" statement holds for the library code, but the SDK forwards whatever
`prompt_tokens` the upstream or gateway sends: `@ai-sdk/openai-compatible` and the OpenRouter
provider pass it through unchecked, and the `cline` / `cline-pass` providers are built on that
path. Real data shows a gateway model that sends it **exclusive of cache**: provider `cline`,
model `minimax/minimax-m2.5`
([real sample: MasterVKT/HIVMeet_FrontEnd, `~/.cline/data/sessions`, March 2026](https://github.com/MasterVKT/HIVMeet_FrontEnd)).
Rows such as `inputTokens 45865 / cacheReadTokens 88671` (cache larger than the whole input) are
impossible for an inclusive count, and the recorded `cost` of all four sampled rows is reproduced
exactly by `input × 0.30e-6 + cacheRead × 0.03e-6 + output × 1.20e-6` with `input` as the fresh
input (the per-million prices are a curve fit, not a cited price list). The same provider id is
inclusive for `deepseek/deepseek-v4-flash` (cost fit with `fresh = input − cacheRead`), so the
provider alone cannot decide.

The rule the adapter applies:

1. Row rule: if `cacheRead + cacheWrite > inputTokens` (strictly; equality is a legitimate
   inclusive row with 0 fresh), the row is exclusive and the fresh input is the reported
   `inputTokens`. Also applied to classic rows of providers outside `CACHE_EXCLUSIVE_PROVIDERS`.
2. Model rule: a (provider, model id) pair, as recorded, with one such row anywhere in the current
   collection is exclusive for all its SDK rows in that collection (a first pass over the session
   files collects the pairs; files are read one at a time, so memory stays bounded). Not applied
   to classic rows.
3. Seed: provider `cline` or `cline-pass` with a model id starting `minimax/` is exclusive even
   before a violating row is seen (a row such as `8281 / cacheRead 6711` does not violate but is
   exclusive by cost). Not seeded: `cline-free/`, `cline-pass/` model prefixes and `:free` models
   (no evidence).

Diagnostics: `exclusiveDetected` counts rows read as exclusive by any of the three rules, shown as
a note; `clamped` should no longer fire on the SDK path.

Still unconfirmed: a gateway model that is exclusive but never violates (and is not seeded) is
still undercounted. The classic handlers for `cline`, `openrouter` and `vercel-ai-gateway` already
clamp (`max(0, prompt − cacheRead − cacheWrite)`) before writing `tokensIn`, so an exclusive
upstream's fresh input is already lost in the file and nothing can recover it. Why the Cline
backend forwards exclusive counts for MiniMax is unknown (the backend is not public).

**Reasoning warning (shipped; confirmed on Cline 3.0.73):** on `main` (after v4.1.21 / SDK 0.0.86), `normalizeUsage` now **subtracts** reasoning tokens from `outputTokens` and puts them in a
separate `reasoningTokenCount`
([`ai-sdk.ts#L1340`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/llms/src/providers/ai-sdk.ts#L1340)),
but when writing to disk `agentMetricsToMetrics` **drops** `reasoningTokenCount`
([`agent-message-codec.ts#L321`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/runtime/config/agent-message-codec.ts#L321)).
The result: the persisted `outputTokens` does not include reasoning for providers that report reasoning
separately (OpenAI/Gemini/xAI and similar), and it cannot be recovered (an undercount). The code has shipped:
Cline CLI 3.0.73 (checked 20 October 2026 with `scripts/e2e/run.mjs`) wrote `outputTokens` 47 for a chat
completion with `completion_tokens` 53, of which 6 were reasoning; only the 47 is on disk and `reasoningTokenCount`
is not written. tokengraph therefore counts the 47. The tags v4.1.0 ... v4.1.21 do not have this subtraction;
there `outputTokens` includes reasoning. Claude models are not affected (Anthropic does not report reasoning
separately).

### B: what must be skipped or handled specially

- **Forked sessions copy messages with their identities.** `/fork` in the CLI moves all the source
  session's messages (`id` and `metrics` included) into the new session; the manifest carries
  `metadata.fork.forkedFromSessionId`
  ([`apps/cli/.../session-runtime.ts` `forkCurrentSession`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/cli/src/runtime/interactive/session-runtime.ts#L621)).
  So the dedup key must be the **message `id` independent of the session** (across files, like
  `response_id` in Codex), not `sessionId:id`. tokscale uses `cline-cli:{sessionId}:{id}`, which
  double counts forks.
- **Imported sessions: skip the messages from before the import.** The SDK can convert Claude
  Code, Codex and OpenCode sessions into a Cline session, copying the source file's usage into
  `metrics`, the source model into `modelInfo` and the source time into `ts`
  ([`session-import/claude-code.ts#L405`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/services/session-import/claude-code.ts#L405),
  [`service.ts#L349`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/services/session-import/service.ts#L349)).
  Counting these would **double count** against tokengraph's `claude-code`/`codex-cli` adapters.
  If the manifest carries `metadata.importedFrom.{tool, importedAt, …}`, count only the assistant
  messages with `ts > importedAt` (the part continued in Cline after the import).
- **Sessions migrated from a classic task: skip the synthetic total.** When the SDK bundle
  continues an old task it opens an SDK session with the same identity (`sessionId = taskId`) and
  carries over `api_conversation_history`; onto the last assistant message it pastes **the whole
  task's total** as a single `metrics` (`inputTokens = tokensIn + cacheReads + cacheWrites`,
  `modelInfo.provider = "unknown"`, no `ts`), then adds a user message with the
  `LEGACY_RESUME_MODEL_WARNING` text
  ([`legacy-task-handling.ts#L158`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/vscode/src/sdk/legacy-task-handling.ts#L158)).
  The same tokens are already counted from the format-A `ui_messages.json`. Rule: if the manifest
  has `metadata.legacyTask` / `migratedFromLegacyTask`, or the messages contain the text
  "Warning: this is a legacy conversation", skip all assistant `metrics` up to that message;
  additionally, `metrics` with no `ts` and `provider: "unknown"` are never counted.
- **`provider === "claude-code"`: skip** (the same reasoning as in A; the SDK uses
  `ai-sdk-provider-claude-code` → `@anthropic-ai/claude-agent-sdk`,
  [`vendors/community.ts`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/llms/src/providers/vendors/community.ts#L85)).
- **Compaction is safe.** `messages.json` keeps the canonical full history; the compacted working
  context is in a separate `<id>.compaction.json` (there `metrics` are removed and written as a
  total on the summary message, [`basic-compaction.ts#L298`](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/src/extensions/context/basic-compaction.ts#L298)).
  `compaction.json` must not be read; if it is read it double counts.
- Sub-agent / team files (`<agentId>.messages.json`) are separate and are not added to the parent
  agent's usage (the parent's usage is updated only from its own stream, `agent-runtime.ts`
  `updateUsage`); all of them must be read, with dedup again by message `id`.

## Timestamp, dedup and file lifecycle

| | A (`ui_messages.json`) | B (`messages.json`) |
| --- | --- | --- |
| Day | `ts` (ms epoch, request start) → local calendar day (`dateKey`) | `ts` (ms epoch, assistant message creation) |
| Dedup key | `taskId` (directory name) + `ts`. One copy per file; if the same task is found in two roots (`~/.cline/data` and VS Code globalStorage), merge by `taskId` | Message `id` (global). Fork/import copies carry the same `id` |
| Rewrites | The whole file is rewritten on every record; the line is updated in place (the numbers grow while the request runs) | Rewritten in full on every turn (not atomic: `writeFileSync`) |
| Deletion | When a task is deleted the `tasks/<id>/` directory is deleted entirely; going back to a checkpoint deletes later lines | When a session is deleted the directory is deleted; after "Reset Chat" or edit-and-regenerate, messages can get shorter |

- A partially written or unparseable file should be skipped in that sync; the ledger's `max()`
  merge keeps the earlier values. A line of a still-running request that is still growing is not
  a problem for the same reason (the next sync takes the larger value; it does not shrink).
- Retries (A): an automatic retry uses the same `api_req_started` line (`retryStatus`); failed
  attempts produce no usage. In a resumed task, the last `api_req_started` with no usage is
  deleted, so nothing is lost.
- Deleted tasks/sessions and checkpoint restores are preserved in the ledger if they were synced
  earlier; if they were never synced they cannot be recovered.

## Roo Code / Kilo Code

tokscale uses the same `ui_messages.json` parser for Cline, Roo Code (`rooveterinaryinc.roo-cline`)
and Kilo Code (`kilocode.kilo-code`) ([`sessions/roocode.rs`](https://github.com/junhoyeo/tokscale/blob/1d9a9395418efc6952944b794097935d7d6fa1e8/crates/tokscale-core/src/sessions/roocode.rs)).
But the format is **not exactly the same**: Roo/Kilo write `apiProtocol` (`"anthropic"`/`"openai"`)
into the `api_req_started` text, and Cline has not written it in any version (v3.10-v3.60 were
checked). Since the normalisation rules depend on provider codes, this note should not be applied
directly to Roo/Kilo; separate research is needed (not gone into).

## Existing third-party tools (cross-check)

- **tokscale** ([`sessions/cline.rs`](https://github.com/junhoyeo/tokscale/blob/1d9a9395418efc6952944b794097935d7d6fa1e8/crates/tokscale-core/src/sessions/cline.rs),
  [`scanner.rs`](https://github.com/junhoyeo/tokscale/blob/1d9a9395418efc6952944b794097935d7d6fa1e8/crates/tokscale-core/src/scanner.rs)):
  - A: only `say:"api_req_started"`; it counts `tokensIn` **as is** as input, so for providers in
    the "included" set (OpenAI Compatible, LiteLLM, xAI, LM Studio...) it counts cache reads
    twice. `deleted_api_reqs`/`subagent_usage` are not read. Model: the line's
    `modelInfo.modelId`, otherwise the `<model>` tag in `api_conversation_history`
    ([PR #1340](https://github.com/junhoyeo/tokscale/pull/1340)).
    Roots: VS Code (macOS/Linux/Windows) + `~/.vscode-server`; no Cursor/Insiders/VSCodium.
  - B: `max(0, inputTokens − cacheRead − cacheWrite)`, the same as our recommendation. Dedup is
    `sessionId:id` (double counts forks) and it does not look at the import/migration markers.
  - The root order is `CLINE_SESSION_DATA_DIR` → `CLINE_DATA_DIR/sessions` →
    `CLINE_DIR/data/sessions` → `~/.cline/data/sessions`, consistent with the Cline source.
- **TokenTracker** PR adding Cline CLI v3 support:
  [xiufengsun/TokenTracker#660](https://github.com/xiufengsun/TokenTracker/pull/660) (the code was not read).
- No Cline support was found in ccusage.

## Not verified

- The example JSON was built from the source code and the official fixture, and the numbers are
  examples. Only Cline CLI 3.0.73 (SDK `*.messages.json`) has been run; no classic `ui_messages.json`
  from the editor extension was produced by a real run.
- The host directory names (`Cursor`, `VSCodium`, `Windsurf`, `~/.cursor-server`, portable mode,
  `--user-data-dir`) are VS Code conventions, do not appear in the Cline source, and were not
  verified one by one.
- That `inputTokens` excludes cache reads/writes on Bedrock Converse rests on the AWS
  documentation; it was not verified in the Cline code or in a real response.
- The AI SDK's Anthropic/Bedrock/Google providers compute `inputTokens.total` inclusive (checked in
  the library code). The OpenAI-compatible and OpenRouter providers pass the upstream
  `prompt_tokens` through unchecked, so inclusive-ness there depends on the upstream; see
  "exclusive rows behind the Cline gateway".
- That `ai-sdk-provider-claude-code` / the Claude Agent SDK writes the session to
  `~/.claude/projects` (and so there is a double-counting risk) is an assumption; not verified.
  The safe side: skip.
- Whether the usage of the classic in-agent compaction (auto-condense) LLM call and of the SDK's
  "agentic compaction" summary call is written to any `api_req_started`/`metrics` was not
  checked; if it is not, it is an undercount.
- The provider conventions are complete for v3.89.2 and `legacy-extension`; for 3.10/3.20/3.40
  only `openai`, `anthropic`, `openrouter`, `openai-native`, `gemini`, `bedrock`, `ollama`,
  `deepseek` and `litellm` were sampled; older versions of the other providers were not checked.
- In tasks before 3.12 there is no per-request model or provider (model `unknown`).
- Whether a later Cline release will persist `reasoningTokenCount` is unknown; 3.0.73 does not.
- Resuming a Cline session was not run: `--id` together with `--json` fails headlessly in 3.0.73.
- Whether the old Cline CLI (Go-based 1.x/2.x) and the JetBrains plugin set `CLINE_DIR` to a
  different place was not checked.

## Checked against real runs

Cline CLI 3.0.73 (`cline` on npm), 20 October 2026, macOS, with `scripts/e2e/run.mjs` (see `scripts/e2e/README.md`):
the real agent in a throwaway `HOME` against a fake LLM server on the chat, responses and anthropic protocols; a
one-shot prompt and a tool loop per protocol. After `sync --local`, input, output, cache read and cache write matched
the server's log per model, except the reasoning tokens described above (rule `cline-reasoning-subtracted`).
Not run: other Cline versions, the editor extension, and any real provider.

## Roots tokengraph scans

Every root below is read together with the default one and the ones remembered in `config.json` (`agentRoots`); roots that reach the same real path are read once, and a missing root is skipped silently. Environment values are trimmed, an empty one is unset, a leading `~` is expanded, and a relative one is ignored. The resolver is `adapters/cline/roots.ts`.

- Cline data folder (`sessions/` for the SDK and CLI, `tasks/` for the standalone and JetBrains build): `~/.cline/data`, `$CLINE_DIR/data`, `$CLINE_DATA_DIR`. The standalone build ignores `CLINE_DATA_DIR` and uses `$CLINE_DIR/data`, so both are read. `$CLINE_SESSION_DATA_DIR` is a sessions folder of its own. All `CLINE_*` values are trimmed, as in the SDK (`storage/paths.ts`); a relative one is ignored.
- Home for `~/.cline`: the SDK takes `$HOME`, then `$USERPROFILE`, then `$HOMEDRIVE$HOMEPATH` (all trimmed, `HOME` first even on Windows, where Git Bash exports it), then `os.homedir()`. tokengraph reads the SDK's home and the OS home, so a `HOME` that differs from `USERPROFILE` no longer hides Cline's sessions. A Git Bash style `HOME` (`/c/Users/me`) is converted on Windows.
- Editor user-data folders (classic `tasks/` under `<user data>/User/globalStorage/saoudrizwan.claude-dev`), one per platform: macOS `~/Library/Application Support`, Linux `$XDG_CONFIG_HOME` and `~/.config`, Windows `%APPDATA%` and `<home>\AppData\Roaming`. Product folders: Code, Code - Insiders, Code - OSS, Cursor, VSCodium, VSCodium - Insiders, Windsurf, Windsurf - Next, Positron, Trae, Kiro, Antigravity. The VS Code, Cursor, VSCodium and Windsurf names come from those products' conventions; Windsurf Next, Trae, Kiro, Antigravity and Positron follow the same convention but have not been checked against an install, and cost nothing when absent.
- Remote server installs, `<home>/<server>/data/User/globalStorage/...`: `.vscode-server`, `.vscode-server-insiders`, `.cursor-server`, `.windsurf-server`, `.vscodium-server`.
- Not followed: `VSCODE_PORTABLE`, `VSCODE_APPDATA` and `--user-data-dir` installs (nothing in a later run can discover them), `code-server` (`~/.local/share/code-server/User/...`, unverified), and a `CLINE_SESSION_DATA_DIR` that is remembered (it is remembered as a sessions folder, which is read).

## Sources

- [cline/cline @ 252082b (main)](https://github.com/cline/cline/tree/252082b9e93b4f91253876391e35b4c13326f5e6): SDK, CLI, A/B loader, migration code.
- [cline/cline @ v3.89.2](https://github.com/cline/cline/tree/e1bdeeff68e95734901c7a4b3a31753bae54a634): the classic task format and providers.
- [cline/cline @ legacy-extension](https://github.com/cline/cline/tree/7761370240ffce9e3890cb56f6c51655f3f5b0a7): the legacy bundle published today.
- [messages.json contract v1](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/packages/core/docs/messages-contract-v1.md)
- [vscode-rollout README](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/apps/vscode-rollout/README.md): the two bundles shipping together.
- [Cline CHANGELOG](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/CHANGELOG.md), [SDK CHANGELOG](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/sdk/CHANGELOG.md)
- [junhoyeo/tokscale @ 1d9a939](https://github.com/junhoyeo/tokscale/tree/1d9a9395418efc6952944b794097935d7d6fa1e8), [tokscale #1321](https://github.com/junhoyeo/tokscale/issues/1321), [tokscale PR #1340](https://github.com/junhoyeo/tokscale/pull/1340)
- [TokenTracker PR #660](https://github.com/xiufengsun/TokenTracker/pull/660)
