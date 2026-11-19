# Codex CLI local token usage data

This note explains how we read token usage from Codex CLI's local files and how it maps onto
tokengraph. The Codex adapter lives in `packages/cli/src/adapters/codex/`; besides Claude Code,
the CLI also collects Codex CLI data (the `codex-cli` source).

The counters here show local session token usage. They are not a ChatGPT plan quota, workspace
Usage Insights or an API billing report. tokengraph's purpose is to show daily token usage, not to
calculate a bill.

## Local data location

Codex's local state directory is set by `CODEX_HOME`; when the variable is not set, the default is
`~/.codex`. That directory holds settings, sessions, logs and other local state files. Current CLI
session records are usually `rollout-*.jsonl` files in date directories under `sessions/`. Codex
may move finished sessions under `archived_sessions/`; the adapter
(`packages/cli/src/adapters/codex/index.ts`) scans both directories (`sessions/` and
`archived_sessions/`) recursively and opens nothing outside them. `CODEX_HOME` and local session
storage are described in the official Codex documentation; the inner schema of the JSONL records,
however, is not documented as a fixed, public integration contract. So the adapter must not assume
a fixed layout, must scan `sessions/` recursively and must parse records defensively.
[Codex environment variables](https://developers.openai.com/codex/environment-variables), [Codex advanced configuration](https://developers.openai.com/codex/config-advanced)

```bash
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

# Session records that exist
find "$CODEX_HOME_DIR/sessions" -type f -name '*.jsonl' -print

# Show only token usage events and their counters; does not print transcript text.
find "$CODEX_HOME_DIR/sessions" -type f -name '*.jsonl' \
  -exec jq -c '
    select(.type == "event_msg" and .payload.type == "token_count")
    | {
        timestamp,
        last: .payload.info.last_token_usage,
        session_total: .payload.info.total_token_usage
      }
  ' {} +
```

`~/.codex/history.jsonl` (or `$CODEX_HOME/history.jsonl`) is a settings-dependent history file
that helps find past conversations; it must not be used as a usage source for tokengraph.
Authentication files are not needed for this job either and must never be read.
[Codex advanced configuration](https://developers.openai.com/codex/config-advanced)

## `token_usage_record` (primary source)

Each line of a session JSONL is a separate JSON record. Current Codex CLI versions (observed
locally: 0.155.1) write a separate `token_usage_record` line for every API response. This is
tokengraph's primary data source:

```json
{
  "timestamp": "...",
  "type": "token_usage_record",
  "payload": {
    "response_id": "...",
    "turn_id": "...",
    "usage": {
      "input_tokens": 0,
      "cached_input_tokens": 0,
      "cache_write_input_tokens": 0,
      "output_tokens": 0,
      "reasoning_output_tokens": 0,
      "total_tokens": 0
    }
  }
}
```

- **`response_id`** uniquely identifies each API request; the adapter dedups the daily total on
  this id **across files**, because a forked or resumed session can copy the earlier file's
  records into the new rollout file.
- **`turn_id`** ties the record to a `turn_context` line in the same file
  (`payload.{turn_id, model}`); the model name is not in the `token_usage_record` itself but is
  read from there. If the same `response_id` is seen in several files, the copy whose `turn_id`
  matches a `turn_context` in its own file and can therefore resolve the model is always preferred
  over a copy that cannot; if none can, the model stays `unknown`. When several copies can resolve
  the model (or none can), the copy with the earliest timestamp (`instant`) wins, and on a tie the
  copy already stored is kept. This choice does not depend on the order the files are read in.
- **`usage`** is the data of the same moment as `token_count.info.last_token_usage` (below); the
  normalisation in the "Mapping to tokengraph fields" section applies to both.

## `token_count` (old format, fallback)

In files that contain no `token_usage_record` (left over from an older Codex version), usage is
taken from `token_count` events of type `event_msg`:

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "last_token_usage": {
        "input_tokens": 0,
        "cached_input_tokens": 0,
        "cache_write_input_tokens": 0,
        "output_tokens": 0,
        "reasoning_output_tokens": 0,
        "total_tokens": 0
      },
      "total_token_usage": { "...": "..." }
    }
  }
}
```

`last_token_usage` carries the latest token amounts for that usage event; `total_token_usage`
carries counters accumulated over the session. When computing the daily total, do not add up each
event's `total_token_usage`: it would count the same earlier usage over and over. The daily total
is computed from `last_token_usage` only.

These events have no `response_id`, so they **cannot be deduplicated across files**. Within a
single file, older Codex versions can rewrite the same `total_token_usage` unchanged when the rate
limit refreshes; the adapter skips a `token_count` whose `total_token_usage.total_tokens` is
exactly the same as the previously counted one in the same file (it is not new information, only
the repeat itself).

The fallback applies when a file has **no** `token_usage_record` line at all. Even a single
corrupt, unparseable `token_usage_record` line makes the file count as "new format" and disables
the fallback, because a real Codex version does not write both in the same file.

The usage fields in the record match the input, cached input, cache-write and output split in the
OpenAI Responses API usage schema. The cache and reasoning fields must not be added back onto the
main input/output counters, or the total is inflated.
[Responses API usage fields](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

## Mapping to tokengraph fields

`packages/core/src/tokens.ts` computes the weighted total like this:

```text
input + output + cache_creation + 0.1 × cache_read
```

Because Codex's `input_tokens` also contains the cache sub-counters, the normalisation applied is
the following (the same for `token_usage_record.usage` and `token_count.info.last_token_usage`):

| Codex field | tokengraph field |
| --- | --- |
| `input_tokens - cached_input_tokens - cache_write_input_tokens` | `inputTokens` |
| `output_tokens` | `outputTokens` |
| `cache_write_input_tokens` | `cacheCreationTokens` |
| `cached_input_tokens` | `cacheReadTokens` |
| no 5 minute / 1 hour cache-write split | `cacheCreation5mTokens` and `cacheCreation1hTokens`: unknown (`null`) |

With this mapping, cached and cache-write tokens are not counted a second time inside
`inputTokens`; `reasoning_output_tokens` is already part of `output_tokens`, so it is not added
separately. Neither `token_usage_record` nor `token_count` carries a model name. The model comes
only from the session context (`turn_context`) that can be tied to the same turn; if no link can
be made, `unknown` is used instead of a guess. The date comes from the JSONL record's `timestamp`
field, produced according to the project's `dateKey` behaviour.

The format of session files can change between Codex versions, and old sessions under
`CODEX_HOME` may have been cleaned up; the data of sessions deleted before the first sync cannot
be recovered from local records.

## Pricing (OpenAI models)

The rules are taken from [OpenAI's API pricing page](https://developers.openai.com/api/docs/pricing)
(22 September 2026) and the [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching). Prices are USD per 1 million tokens
and are API prices; they are not the cost of a ChatGPT subscription or of Codex's in-plan usage
quota. Local Codex token records do not contain API spend or ChatGPT plan credit, so do not show
the cost as an exact bill.

- `input_tokens` also contains cached and cache-write tokens; that is why the normalisation in
  "Mapping to tokengraph fields" (subtracting both from input) is needed.
- **Cache write**: for GPT-5.6 and later models it is 1.25× the input price (a single TTL, 30
  minutes); for older models (gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex) there is no
  surcharge and it is counted at the input price. Unlike Anthropic there is a single rate, with
  no 5 minute / 1 hour TTL split.
- **Long context**: if a request's `input_tokens` exceeds 272,000, the whole request (input +
  cache read + cache write) is priced at 2× and output at 1.5× (from the [gpt-6-luna model
  page](https://developers.openai.com/api/docs/models/gpt-6-luna) and the `<272K` labels in the pricing table).
  The threshold is read from the model's own rate entry (`longContextThreshold` in `pricing.ts`; 272K is the
  default, Gemini and xAI models use 200K, Claude Haiku 5.5 100K), and a model without long-context rates
  keeps its long requests in their own, unpriced tier.
- **Fast mode** (`service_tier` `fast`, or `priority` by its old name): the whole applied price
  is 2×, unless the model's entry says otherwise (`fastMultiplier`: a different multiple, or `null` where
  OpenAI publishes no fast row, e.g. the nano, codex and o1 models, which then stay unpriced).
- These four cases (standard / long-context / fast / fast-long-context) are stored separately as
  the pricing tier: model names stay clean, and the cost is computed from the request's tier
  (`pricingTierFor`, per request, before summing).

The source for the current model list and the figures is `packages/core/src/pricing.ts`
(`RATES`). They are not repeated here so the two places cannot drift apart; when a price changes,
only that file is updated (a new `effectiveFrom` entry; an existing figure is never changed). The
scope is limited to text tokens: images, audio, video, Batch/Flex processing modes and regional
data-residency differences are out of scope. A model that is not in the table stays unpriced
("unknown", not `$0`).

## Implementation

The adapter's real files:

- `packages/core/src/sources.ts`: `CODEX_CLI_SOURCE = 'codex-cli'`, `KNOWN_SOURCES`. A new
  source must be defined here or the ledger will not accept its usage.
- `packages/core/src/pricing-tiers.ts`: the `PricingTier` type, `pricingTierFor()`, the 272K
  threshold (`LONG_CONTEXT_THRESHOLD_TOKENS`).
- `packages/core/src/pricing.ts`: OpenAI model prices (`RATES`) and `costForSplitCounts`
  (cache-write multiplier, long-context and fast-mode multipliers).
- `packages/core/src/types.ts`: `DailyModelUsage` carries a `pricingTier` field.
- `packages/cli/src/adapters/codex/index.ts`: `createCodexAdapter()` scans `sessions/` and
  `archived_sessions/` under `CODEX_HOME` (default `~/.codex`) recursively; `history.jsonl`, auth
  and other files are never opened.
- `packages/cli/src/adapters/codex/aggregator.ts`: `CodexUsageAggregator` parses the lines,
  dedups across files by `response_id`, computes the tier and counts fallback/malformed/clamp
  diagnostics. The "distinct API requests read" count that `sync` prints, and the fallback event
  count, cover only events inside the `--since` window; events outside the window (even if they
  are in the file) are neither counted nor added to the daily totals.
- `packages/cli/src/ledger.ts`: the local ledger is keyed by source × tier (v3:
  `sources[source][date][model][tier]`); v1/v2 ledgers migrate to the `claude-code` + `standard`
  tier.
- `packages/cli/src/collect-local.ts`: the adapter list that `sync` and `view` share.

The adapter processes only token usage records (`token_usage_record`, and `token_count` as the
fallback); it does not read prompts, model replies, tool output, file paths or session metadata
into the ledger. What tokengraph keeps is limited to token counters per day, model, source and
tier.

## Not verified

- Codex versions 0.155.1 (local files) and 0.163.0 (a run against a fake Responses API server, 20 October
  2026, with `scripts/e2e/run.mjs`; counters matched exactly) were observed; other versions were not.
- `cache_write_input_tokens` was always 0 in local samples; the rule itself (1.25× for GPT-5.6+)
  was taken correctly from the documentation but was not verified with a real non-zero value.
- The `service_tier` value Codex writes while fast mode is on was never seen. `fast` and
  `priority` are both counted as the fast tier, which rests on that assumption.
- The 272K long-context threshold was taken from the `gpt-6-luna` model page and the `<272K`
  labels in the pricing table; each model page was not verified individually.
- `archived_sessions/` does not exist on this development machine; that the adapter scans this
  directory correctly was not tested with real data.
- The regional data-residency price increase (listed separately on the API pricing page) is not
  taken into account, because the region of processing cannot be known locally.
- The cost is API-equivalent; with a ChatGPT plan it is not a real bill.

## Background sync: `notify` or a `Stop` hook

`tokengraph install-hook --agent codex` makes Codex run `hook-sync --min-interval 600` (the same command either way,
built from `codexNotifyArgs()`, so through `bin-path.ts`) once at the end of every turn. `hook-sync` starts a detached
`sync` at most every 10 minutes, prints nothing and exits 0 at once. Code: `codex-config-toml.ts`, `codex-hooks.ts`,
`commands/install-hook.ts`; detection in `tui/auto-sync.ts` (`inspectCodexSetup`) and `auto-sync-health.ts`.

**Which mechanism.** Codex's top-level `notify` in `config.toml` holds one program. When it is free (or already
ours) tokengraph writes its `notify` line, as before. When another program holds it, tokengraph adds a `Stop` hook
to `$CODEX_HOME/hooks.json` instead and never touches that `notify`. Codex's own Computer Use writes one:
`notify = [".../Codex Computer Use.app/.../SkyComputerUseClient", "turn-ended"]`, so every Codex desktop user with
Computer Use is in this case. A hook that is already installed is kept and refreshed even after `notify` frees up.
Neither is written when Codex would ignore it: hooks turned off (`[features] hooks = false`, or the older
`codex_hooks`, in `config.toml`; `[features] hooks = false` or `allow_managed_hooks_only = true` in
`/etc/codex/requirements.toml`) or `codex --version` older than 0.124.0. The command then fails, changes nothing
and points at `tokengraph schedule`; the Setup item is not recommended, says why, and the hourly sync becomes the
Codex step. When no `codex` answers on PATH (the desktop app ships its own), the hook is written and the output
names the minimum version.

**Codex hooks, as tokengraph relies on them** (codex-cli 0.155.1; checked in the `rust-v0.155.1` source and by a real run):

- Files: `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`), or inline `[hooks]` in `config.toml`; also
  `/etc/codex/hooks.json`, trusted project `.codex/hooks.json` and plugins. Codex loads every source and runs every
  matching hook; one layer with both a `hooks.json` and inline `[hooks]` loads both and warns. tokengraph uses only
  the user `hooks.json`: JSON is edited with a parser, the user's `config.toml` is never given hook tables.
- `hooks.json` shape: `{ "description"?: string, "hooks": { "<Event>": [ { "matcher"?: regex, "hooks": [ handler ] } ] } }`,
  no other top-level keys (`HooksFile` is `deny_unknown_fields`). Command handler: `type: "command"`, `command`,
  optional `commandWindows`, `timeout` (seconds; 600 by default, `SessionEnd`/`Interrupt` 1 s capped at 3 s),
  `async`, `statusMessage`. tokengraph writes `{ "type": "command", "command": "\"<node>\" \"<bin.js>\" hook-sync --min-interval 600", "timeout": 30, "statusMessage": "tokengraph: sync usage" }`
  in a group of its own, appended after any existing `Stop` groups.
- Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`,
  `SubagentStart`, `SubagentStop`, `Stop`, `PreModelRequest`, `PostModelRequest`, `Interrupt`, `SessionStart`,
  `SessionEnd`. **`Stop` fires once at the end of each turn** (matchers are ignored for it). `SessionEnd` only fires
  on archive, delete, close or 30 idle minutes, and is capped at 3 s.
- How it runs: `$SHELL -lc "<command>"` (`cmd.exe /C` on Windows) in the turn's working folder, with the session's
  environment (HOME, CODEX_HOME and TOKENGRAPH_HOME reach it), stdin piped, stdout and stderr captured. stdin is
  one JSON object: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
  `permission_mode`, `stop_hook_active`, `last_assistant_message`. `hook-sync` does not read it; a hook that exits
  without reading is fine (a broken pipe on that write is ignored). A hook that exits 0 may leave a detached child
  running (Codex kills the process group only on a timeout or failure), which is how the background `sync` survives.
- Output: exit 0 with empty stdout = continue normally. `Stop` can only block or alter the turn with JSON on stdout
  (`decision: "block"` + `reason` makes Codex continue with that reason as a new prompt, `continue: false` stops)
  or exit 2 with a reason on stderr; plain text on stdout is reported as an invalid-output failure. `hook-sync`
  prints nothing and always exits 0. `async: true` is not used: releases before 0.150 skip async hooks entirely.
- Feature flag: `hooks` (stable, on by default; `codex_hooks` is the older name and still accepted). Hooks became
  stable and on by default in **0.124.0** (`Feature::CodexHooks`, key `codex_hooks`, `UnderDevelopment` through
  0.123.0); the key became `hooks` in 0.129.0.
- **Approval ("trust").** Since 0.129.0 Codex runs a user hook only after it is trusted. It is stored in
  `config.toml` as `[hooks.state."<hooks.json path>:stop:<group>:<handler>"] trusted_hash = "sha256:…"`, a hash of the
  normalised hook, so a changed hook needs trusting again; `enabled = false` there turns a hook off.
  `--dangerously-bypass-hook-trust` skips this for one run. Codex reads `hooks.json` only when it starts, so a
  Codex that was already open sees nothing new. How a person trusts it (checked in the source at each tag, and on
  0.170.0 in a pseudo-terminal):
  - 0.131.0 and later: at startup, with a new or changed hook, Codex shows "Hooks need review / 1 hook is new or
    changed" with `1. Review hooks`, `2. Trust all and continue`, `3. Continue without trusting (hooks won't run)`.
    `2` is the only choice that trusts, and it needs an explicit confirmation (0.170.0: pressing `2` moves to it,
    Enter confirms; `1` and `3` act at once). Which row starts selected is not something to rely on (on 0.170.0 it
    was `1` in our run; the user saw `3`), so the steps say "press 2, then Enter" and "Enter alone does not trust it".
  - 0.129.0 and later: `/hooks` lists events (Event / Installed / Active / Review); Enter on `Stop` opens its hooks,
    `t` trusts the selected one (0.131.0 and later also have `t` = trust all on the events page), Space turns a trusted hook on
    or off, Esc goes back.
  - 0.124.0 to 0.128.x: no trust step; hooks run once Codex restarts.
  - The Codex app: the docs name Review hooks in the composer and Settings › Hooks.
- **The name /hooks shows** is the handler's `statusMessage` (`hooks_browser_view.rs`: the title is `status_message`,
  else "Unnamed hook"); Codex also shows it while the hook runs. tokengraph sets it to `tokengraph: sync usage`.
  A hook installed before this field was set is refreshed in place, which changes its hash, so Codex asks once more.
- **What tokengraph does about it.** It never writes an approval. `codexTrustSteps(version)` words the steps for the
  version `codex --version` reports (a current Codex when none answers). `install-hook --agent codex` prints them
  after installing, and again instead of "already installed" while Codex has not trusted the hook. In the view the
  Codex hook item runs in the task box, so the steps are shown in full; while the hook waits for trust the item is
  marked `!`, reads "trust it in Codex (Enter for steps)", pressing it shows the steps again (it does not remove the
  hook), and the step does not count as done. `status` reports "not trusted in Codex yet, so it does not run" with
  `next: tokengraph install-hook --agent codex`. Trust is read as the presence of an approval for our key; the hash
  is not checked. Because the key is the hook's position, a refresh keeps our entry where it is, and a removal leaves
  an empty `{ "hooks": [] }` group when groups follow ours, so the hooks after it keep their approvals.
- `--remove` and `uninstall` take out only tokengraph's handler (and its approval table in `config.toml`, when that
  table holds nothing else), delete `hooks.json` when nothing else is left in it, and keep a `.tokengraph.bak`
  copy of each file they change, as for the other agents.

**Real run** (codex-cli 0.155.1, throwaway `HOME`/`CODEX_HOME`/`TOKENGRAPH_HOME`, a local fake Responses-API
server as a custom `model_provider`, a Computer-Use-style `notify` in `config.toml`): `install-hook --agent codex`
wrote the hook and left `config.toml` byte for byte; an unapproved hook did not run; after the approval Codex
/hooks makes (`hooks/list`, then `config/batchWrite` of `hooks.state`) a `codex exec` turn printed
`hook: Stop` / `hook: Stop Completed`, `hook-sync` started a sync that recorded the turn's tokens, and the
foreign `notify` still fired on every turn; a second turn inside 10 minutes ran the hook and skipped the sync;
`--remove` deleted `hooks.json`, removed the approval and left `config.toml` identical to the original.

## Roots tokengraph scans

Every root below is read together with the default one and the ones remembered in `config.json` (`agentRoots`); roots that reach the same real path are read once, and a missing root is skipped silently. Environment values are trimmed, an empty one is unset, a leading `~` is expanded, and a relative one is ignored. The resolver is `adapters/codex/roots.ts`.

- Roots: `~/.codex`, and `$CODEX_HOME` when it is a non-empty absolute path (an empty `CODEX_HOME` is unset, as in Codex's `utils/home-dir`; a relative value is ignored, because Codex resolves it against its own working directory).
- Read through `sessions/` and `archived_sessions/` only. Files are deduplicated by real path across roots as well as by `response_id`, because older rollouts carry no `response_id` (`fallbackEvents`) and a second copy of one would count twice. Two profiles with different rollouts add up.

## Sources

- [Codex environment variables](https://developers.openai.com/codex/environment-variables): the default and scope of `CODEX_HOME`.
- [Codex advanced configuration](https://developers.openai.com/codex/config-advanced): local state, history and telemetry settings.
- [Codex CLI](https://developers.openai.com/codex/cli): the local CLI and resuming sessions.
- [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create): the token usage fields on the API side.
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing): input, cached input, cache write and output prices per model.
- [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching): the relation between `input_tokens` and the cache sub-counters.
- [gpt-6-luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna): the 272K long-context threshold and the fast mode multiplier.
- [Codex hooks](https://developers.openai.com/codex/hooks) (now served from learn.chatgpt.com/docs/hooks): file locations, the `hooks.json` and `[hooks]` shapes, events, stdin, exit codes and output, timeouts, the `hooks` feature flag and hook approval.
- [Codex configuration reference](https://developers.openai.com/codex/config-reference) (now learn.chatgpt.com/docs/config-file/config-reference): `features.hooks` (with `codex_hooks` as its deprecated alias), the inline `[hooks]` table with the same event schema as `hooks.json`, and `notify` (one command that receives a JSON payload).
- openai/codex at tag `rust-v0.155.1`: `codex-rs/config/src/hook_config.rs` (`HooksFile`, `HookHandlerConfig`, `HookStateToml`), `codex-rs/hooks/src/engine/discovery.rs` (loading, timeouts, trust), `codex-rs/hooks/src/lib.rs` (`hook_key`), `codex-rs/hooks/src/engine/command_runner.rs` (shell, stdin, process cleanup), `codex-rs/hooks/src/events/stop.rs` (Stop output handling), `codex-rs/tui/src/hooks_rpc.rs` (how `/hooks` records an approval), `codex-rs/tui/src/startup_hooks_review.rs` and `codex-rs/tui/src/bottom_pane/hooks_browser_view.rs` (the startup prompt and `/hooks`; compared at `rust-v0.129.0`, `0.130.0`, `0.131.0`, `0.133.0` and `0.170.0`), `codex-rs/features/src/lib.rs` (`Feature::CodexHooks`; compared at tags `rust-v0.123.0`, `rust-v0.124.0`, `rust-v0.128.0`, `rust-v0.129.0`).
