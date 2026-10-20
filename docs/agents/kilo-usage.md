# Kilo CLI local token usage data

This note explains where, and in what format, Kilo CLI (`Kilo-Org/kilocode`, the `kilo` command and
Kilo Code 7.x for VS Code) stores per-request token usage in its local files, and how to normalise
it into tokengraph's fields. The adapter lives in `packages/cli/src/adapters/kilo/`; it is
`packages/cli/src/adapters/opencode/` (the OpenCode adapter) with Kilo's own file names and version
thresholds. Read `docs/agents/opencode-usage.md` first: the storage layout, the `getUsage()` history,
the dedup rules and the arithmetic are all defined there, and this note only records what differs.

Everything below was worked out from the source code (`main`, commit
[`2a1903f`](https://github.com/Kilo-Org/kilocode/tree/2a1903f29186e25adec0bace14f6ee589095f7eb),
17 October 2026, version 7.8.14, full git history fetched to date the version boundaries), then checked by
running Kilo CLI 7.8.12 against a fake endpoint (see "Checked against real runs").

In short: `packages/opencode` in Kilo's repository is a fork of OpenCode v1 (changes are marked
`kilocode_change`). It writes the same `session` / `message` / `part` SQLite tables and the same
`tokens: {input, output, reasoning, total, cache: {read, write}}` objects, but under Kilo's own
release numbers, so every version threshold in the OpenCode note has to be re-keyed.

## Local data location

- Data directory: `${XDG_DATA_HOME:-~/.local/share}/kilo` on every OS (xdg-basedir with `app = "kilo"`;
  never `~/Library/...` on macOS, and on Windows without `XDG_DATA_HOME` it is
  `%USERPROFILE%\.local\share\kilo`).
  ([core/src/global.ts#L12-L22](https://github.com/Kilo-Org/kilocode/blob/2a1903f29186e25adec0bace14f6ee589095f7eb/packages/core/src/global.ts#L12-L22))
- Database: `DATA/kilo.db`. `KILO_DB` overrides it (an absolute path, a path relative to `DATA`, or
  `:memory:`). A release channel other than `latest` / `beta` / `prod` writes `DATA/kilo-<channel>.db`
  and falls back to an existing `DATA/opencode-<channel>.db`; `KILO_DISABLE_CHANNEL_DB=1|true` turns the
  suffix off.
  ([core/src/database/database.ts#L48-L65](https://github.com/Kilo-Org/kilocode/blob/2a1903f29186e25adec0bace14f6ee589095f7eb/packages/core/src/database/database.ts#L48-L65),
  [opencode/src/storage/db.ts#L32-L48](https://github.com/Kilo-Org/kilocode/blob/2a1903f29186e25adec0bace14f6ee589095f7eb/packages/opencode/src/storage/db.ts#L32-L48))
- The adapter reads every `kilo.db`, `kilo-<channel>.db` and `opencode-<channel>.db` in `DATA`, or only
  `KILO_DB` when it is set. A plain `opencode.db` is not read: Kilo renamed it to `kilo.db` on
  2026-02-23 (`5f161009d7`), before its first release with SQLite (**v7.0.26**).
- WAL mode: the adapter opens the file read-only with a busy timeout, as for OpenCode.
- Other clients write the same file: the VS Code extension 7.x is a thin client over the CLI and sets no
  data directory of its own (`kilo-vscode/AGENTS.md`), and the Agent Manager and the JetBrains plugin
  use it too. They are counted by this one adapter.
- Not read: releases before v7.0.26 kept JSON under `DATA/storage/` (OpenCode's pre-1.2 layout, a
  different and older format; no release tags before v7.0.26 exist to date it), and the legacy VS Code
  extension (5.x, `kilocode-legacy`) stores no model id per request. `auth.json`, `log/` and every
  other file in `DATA` are never opened.

## Record shape

Identical to OpenCode v1 (`core/src/session/sql.ts#L24-L114`): `message.data` (assistant) and
`part.data` (`type: "step-finish"`) both carry the `tokens` object, written by
`packages/opencode/src/session/processor.ts#L669-L720` (`Session.getUsage(...)`,
`assistantMessage.tokens = usage.tokens`, then a `step-finish` part). Kilo adds `time`, `model`,
`generationID`, `vercelID` and `metrics` to the step-finish part; none of them changes the counters.

```json
{"id":"prt_…","messageID":"msg_…","type":"step-finish","reason":"stop","cost":0.012,
 "model":{"providerID":"kilo","modelID":"anthropic/claude-sonnet-4.5"},
 "tokens":{"total":1730,"input":600,"output":120,"reasoning":10,"cache":{"read":1000,"write":0}}}
```

(Field names from the writer; the numbers are made up.) The `session` row has `version`, the Kilo
version that created it (`InstallationVersion`, the string `"local"` for a development build), and
`time_created`.

The HEAD schema also has the `session_message` table that OpenCode v2 uses
(`core/src/session/sql.ts#L135`), filled by `core/src/session/projector.ts`. Whether the released
CLI writes it was not established; the adapter reads it the same way it does for OpenCode (period D
semantics, dropped when its id or identity matches a v1 message) so nothing is lost or doubled either
way.

## Semantics and the version boundary

`getUsage()` is upstream's, with Kilo-only changes limited to cost. The four periods in the OpenCode
note ("Field semantics: the history of `getUsage()`") apply at **Kilo's own release numbers**, checked
with `git show <tag>:packages/opencode/src/session/index.ts` (and `session.ts` from v7.2.5):

| OpenCode period | Kilo release | Evidence |
| --- | --- | --- |
| B: input excludes cache (conditional), output provider-dependent | v7.0.26 to v7.2.4 (2026-02-23 to 2026-04-12) | `excludesCachedTokens` is present at v7.2.4 |
| C: input excludes cache, output includes reasoning | v7.2.5 only (2026-04-13) | no `excludesCachedTokens`; `output: outputTokens` at v7.2.5 |
| D: five fields disjoint, `output = outputTokens - reasoningTokens` | v7.2.6 and later (2026-04-14+) | `output: outputTokens - reasoningTokens` at v7.2.6 (`280eb16e77`) |

The AI SDK 6 upgrade (`c33d9996f0`) and the double-count fix (`72c77d0e7b`) both first ship in v7.2.5,
so Kilo never had OpenCode's 1.3.4-1.3.5 window where `total` double-counts cache.

Consequences for the adapter, which shares `resolveV1Tokens` with OpenCode and passes Kilo's rules:

- **Period-D shortcut at 7.2.6, not 1.3.16.** Every Kilo version is above 1.3.16, so OpenCode's threshold
  would read all of 7.0.26-7.2.5 as period D and add reasoning to an output that already includes it.
- **No `aisdk6-window` skip.**
- **Records from before 7.2.6 are not trusted blindly.** They follow the OpenCode "decision rule for
  old records": `tokens.total` (present since the SQLite era, e.g. at v7.0.26) is used to keep a reading
  only when exactly one arithmetic reading matches it; a record with cache or reasoning and no `total`,
  or with several disagreeing readings, is skipped and counted in the note
  `skipped N Kilo request(s) from before v7.2.6 whose token fields cannot be interpreted with certainty`.
  A session version that is not a plain `x.y.z` (`local`) takes the same path.
- tokengraph output = `output + reasoning` (period D) so output includes reasoning; input is the
  non-cached input; `cache.read` and `cache.write` map to cache read and creation. The 5m/1h
  cache-write split is never stored, so it is `null`.

## Dedup unit and traps

- Request unit: a step-finish part, or the message's own `tokens` when it has none; message `tokens` are
  overwritten (not summed) by each step, so never add them to the parts. Same as OpenCode.
- **Fork copies**: `kilocode/session/fork.ts` clones messages and parts (`structuredClone`) under new ids
  with identical counters. The OpenCode fingerprint dedup (time, provider, model, tokens, cost, agent)
  catches them.
- Sub-agent sessions are separate session rows (`parent_id`) and separate requests. Compaction summary
  messages are real requests.
- The `claude-code` provider does not exist in Kilo (grep of `packages/opencode/src` and
  `packages/core/src` finds nothing), but the shared code skips it anyway, so a Claude Code session
  routed through it could never be counted twice.
- Sessions migrated from the old VS Code extension are inserted as assistant messages with
  `providerID: "legacy"`, `modelID: "legacy"` and all-zero tokens
  (`kilo-vscode/src/legacy-migration/sessions/lib/messages.ts#L53-L76`). They are skipped silently so
  they do not add empty requests.

## Model attribution

`message.modelID` and `message.providerID` (typically provider `kilo` for the Kilo gateway, with
`modelID` like `anthropic/claude-sonnet-4.5` or `minimax/m2.5`). For routed ids (`kilo-auto/*`,
`openrouter/*`) the real model is written on the step-finish part as `model: {providerID, modelID}`
(`kilocode/session/routed-model.ts#L55-L63`, `processor.ts#L677-L683`); the adapter prefers a step's own
`model` and falls back to the message's. The shared `canonicalModelId` then strips a gateway's
`anthropic/` / `openai/` / `google/` vendor prefix and normalises Claude ids; any other id
(`minimax/m2.5`, `kilo-auto/frontier`) is kept as recorded and is unpriced unless the pricing table
knows it. Never guess a rate.

## Timestamp and retention

`message.data.time.created` (ms), falling back to the row's `time_created`. Kilo has an opt-in
retention pass (`kilo.json` `retention.enabled` / `maxAgeDays`, default 30 days, disabled unless
enabled, `kilocode/session/retention.ts#L14-L36`) and users can delete sessions, but nothing is deleted
by default, so `status` has no retention policy for Kilo. The ledger's max-merge keeps what was synced.

## Format history

Kilo merges OpenCode upstream regularly (`script/upstream/`) and renumbers releases, so semantics changes
arrive with a delay and under Kilo's own version. Kilo-specific schema additions are additive. A new
semantics change would need a new threshold in `packages/cli/src/adapters/kilo/index.ts`.

## Content isolation

Only `json_extract` of `tokens`, `modelID`, `providerID`, `time`, `agent`, `cost` and a part's
`model.providerID` / `model.modelID`, plus `session.id`, `version` and `time_created`. Prompt and
response text, tool output, `session.directory` and `title` are never selected.

## Roots tokengraph scans

Every root below is read together with the default one and the ones remembered in `config.json` (`agentRoots`); roots that reach the same real path are read once, and a missing root is skipped silently. Environment values are trimmed, an empty one is unset, a leading `~` is expanded, and a relative one is ignored. The resolver is `adapters/kilo/roots.ts`.

- Roots: `~/.local/share/kilo` on every OS, and `$XDG_DATA_HOME/kilo` when set to a non-empty absolute path. Each root contributes every `kilo*.db` (and the `opencode-<channel>.db` Kilo falls back to).
- `$KILO_DB` names one more database (absolute as is, relative against the data folder); it is added to the folder scan rather than replacing it. Same dedup as OpenCode: message ids and fork fingerprints are unique across databases.

## Citations

- Kilo-Org/kilocode, commit [`2a1903f`](https://github.com/Kilo-Org/kilocode/tree/2a1903f29186e25adec0bace14f6ee589095f7eb) (version 7.8.14); tags v7.2.4, v7.2.5, v7.2.6, v7.0.26.
- `packages/core/src/global.ts`, `packages/core/src/database/database.ts`, `packages/opencode/src/storage/db.ts`,
  `packages/core/src/session/sql.ts`, `packages/opencode/src/session/processor.ts`,
  `packages/opencode/src/kilocode/session/{fork,routed-model,retention}.ts`,
  `packages/kilo-vscode/src/legacy-migration/sessions/lib/messages.ts`.
- Cross-check only: tokscale's `kilo.rs` fixture (a Kilo message with `providerID: "kilo"`,
  `modelID: "minimax/m2.5"`).

## Checked against real runs

Kilo CLI 7.8.12 (`@kilocode/cli`), and again on 20 October 2026 with `scripts/e2e/run.mjs` on 7.8.15 (macOS; counters matched exactly on the chat, responses and anthropic protocols; see `scripts/e2e/README.md`). Method: the real agent was installed into a throwaway folder and run with a throwaway `HOME` against a local fake LLM endpoint (OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, streaming). The endpoint gave every request distinct fresh-input, cache-read, cache-write and output counts and logged them; that log is the independent count. `tokengraph sync --local` then read the agent's own files in that home, and its totals were compared field by field with the log.

- Providers: `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` with a custom `baseURL` in
  `~/.config/kilo/kilo.json`. Runs: `kilo run` on each, `kilo run -c` (continue), and one prompt per provider
  that made the model call the `glob` tool first (two steps in one message). 7 requests in all, read from
  `~/.local/share/kilo/kilo.db`; every field matched the endpoint exactly, so the step-finish rule holds for
  multi-step messages.
- Still open: whether any released build wrote `DATA/opencode.db` before the rename; whether the released CLI
  writes `session_message` rows; and whether gateway ids other than the vendor prefixes handled by
  `canonicalModelId` need more normalisation.
