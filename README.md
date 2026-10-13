# tokengraph

Track how many tokens you burn each day across your AI coding tools, and
optionally sync the numbers to a tokengraph server so they show up on your
personal graph and (if you opt in) a leaderboard. The CLI works fully on its
own: it reads your usage, keeps it on your machine, and shows it in a
dashboard right in your terminal. Uploading is opt-in.

This is the client side of tokengraph: the CLI and the shared calculation
library it uses. It talks to a tokengraph server over HTTPS with a per-machine
API key; it contains no server, dashboard or database code, and no
credentials.

## What it does

tokengraph counts your daily token usage per model, for each supported
coding tool, and turns it into a GitHub-contribution-graph-style heatmap.
Everything is a **weighted-token** count:

```text
weighted = input + output + cache write + 0.1 × cache read
```

Cache reads are weighted down because they're far cheaper than fresh input —
without that, a long session with a huge cached context would dominate the
graph over a day of real work. This number is a **work proxy, not a bill**:
it does not try to reproduce your actual invoice, and where a rate isn't
known the server reports that model's cost as unknown rather than guessing
$0. The terminal view shows an estimated cost from the same rate table the
server uses (`packages/core/src/pricing.ts`); models without a known rate are
shown as unpriced, never as $0.

Six tools are supported today: Claude Code, Codex CLI, Cursor, Gemini CLI,
Cline, and OpenCode.

## Install

Needs Node.js 22 or newer.

```bash
npm install -g tokengraph
```

Install it globally rather than running it through `npx`: hooks and the
hourly schedule store the path of the installed CLI, and a copy in npx's cache
can be deleted at any time. `install-hook` and `schedule` refuse to run from
such a cache.

If you later switch Node versions with a version manager (nvm, fnm, volta…),
the hooks still point at the old one. `tokengraph status` flags a hook or
schedule whose program is gone; re-run the command it suggests.

## Quick start

Local-first, no account needed:

```bash
# set up whichever tools you use — see the table below
tokengraph sync                         # read local usage into the local ledger
tokengraph                              # explore it in the terminal
```

To also publish your graph to a tokengraph server:

```bash
tokengraph login                        # link this machine to a tokengraph server
tokengraph sync                         # aggregate local usage and upload it
```

By default the CLI talks to `http://localhost:3000`. Point it at a real
server with `--api-url <url>` on `login`, or by setting `TOKENGRAPH_API_URL`.

### Per-agent setup

| Agent | Where usage comes from | Hook | What you need to do |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) | optional | Nothing required. `tokengraph install-hook --agent claude-code` wires a hook that starts a background `sync` when a session ends (the hook itself returns immediately; the sync's output goes to `~/.tokengraph/hook-sync.log`). Claude Code deletes old transcripts, so sync at least every few weeks — the local ledger only keeps what it has already seen. |
| Codex CLI | `~/.codex/sessions` and `archived_sessions` (or `$CODEX_HOME`) | optional | Nothing required — just run `sync`. `tokengraph install-hook --agent codex` adds a `notify` entry to `$CODEX_HOME/config.toml` that starts a background `sync` after a turn, at most once every 10 minutes. Codex allows a single `notify` command, so the installer refuses to overwrite one that isn't tokengraph's. |
| Cursor | Cursor keeps no usable token counts on disk | **required** | Run `tokengraph install-hook --agent cursor` once and restart Cursor. Usage is counted only from that moment on — Cursor gives no way to recover history from before the hook was installed. The hook only records each agent turn to `~/.tokengraph/cursor-events.jsonl`; it never uploads on its own — run `sync` (or `tokengraph schedule`) to upload what it recorded. |
| Gemini CLI | `~/.gemini/tmp/*/chats/` (or `$GEMINI_CLI_HOME`), plus `~/.cache/.gemini/tmp` (the macOS sandbox's copy) | none | Nothing required — just run `sync`, or `tokengraph schedule` to sync every hour. |
| Cline | VS Code's global storage for `saoudrizwan.claude-dev/tasks` and `~/.cline/data/sessions` | none | Nothing required — just run `sync`, or `tokengraph schedule` to sync every hour. |
| OpenCode | `~/.local/share/opencode/opencode*.db` and its `storage/` directory (or `$XDG_DATA_HOME`) | none | Nothing required — just run `sync`, or `tokengraph schedule` to sync every hour. Reading `opencode.db` needs Node 22.13+ for its built-in `node:sqlite`; on an older Node the pre-1.2 JSON storage is still read. |

## Daily use

Run `tokengraph sync` whenever you want your numbers up to date — for
example once at the end of the day — or let the hooks and `tokengraph schedule`
do it for you:

```bash
tokengraph sync                 # reads local logs, updates the ledger; uploads only when logged in with uploads on
tokengraph sync --since 30      # only look back 30 days (default: 90)
tokengraph sync --local         # update the local ledger without uploading
tokengraph view                 # open the terminal dashboard
tokengraph status               # account, ledger, and which background syncs are installed
```

## Local mode

Nothing leaves your machine unless you log in and leave uploads on.

```bash
tokengraph uploads              # show the current setting
tokengraph uploads off          # keep everything local, even when logged in
tokengraph uploads on           # allow sync to upload again
tokengraph sync --local         # one-off: update the ledger, never upload
```

- **Never logged in:** `sync` reads your usage, updates the local ledger and
  exits 0 without contacting any server (when at least one supported tool's
  data is found; with none it still exits 1).
- **Uploads off:** `sync` behaves the same even when this machine is logged in.
  `tokengraph login` does not turn uploads back on; only `tokengraph uploads on` does.
- **Hooks and the hourly schedule** run the same `sync`, so they follow the
  same rule: with uploads off or nobody logged in they only update the local
  ledger. Installing a hook or the schedule is safe in local mode.

## Terminal view

```bash
tokengraph view                # or just `tokengraph` in an interactive terminal
tokengraph view --print        # static snapshot, no interaction
```

Running `tokengraph` with no arguments in an interactive terminal (both stdin
and stdout are a TTY) opens the view; otherwise it prints help. When stdout
or stdin is not a terminal, or with `--print`, `view` prints a static snapshot and exits.

The view reads your local usage (and the local ledger) and has four tabs:

- **Overview** — big stat tiles, a year heatmap coloured by model family, a
  last-30-days chart, a panel for the selected day, and your top models.
- **Models** and **Agents** — ranked tables for 7d / 30d / 90d / 1y / all, with
  stacked charts.
- **Insights** — streaks, your record day, favourite model, busiest weekday,
  and the last 12 months.

A `LIVE` indicator means the view rescans recent days while it is open. The
mouse works too: click tabs, days and rows.

| Key | Action |
| --- | --- |
| `1`-`4`, `Tab`, click | switch tab |
| arrows, mouse | move day cursor / row selection |
| `[` `]` | previous / next year (Overview) |
| `t` | jump to today |
| `r` | cycle range (Models, Agents) |
| `c` | per-family / single-hue colour |
| `s` | rescan now |
| `?` | toggle the help overlay |
| `q`, `Esc`, `Ctrl-C` | quit |

Options: `--print` (static snapshot), `--no-motion` (skip animations; also
`TOKENGRAPH_NO_MOTION=1`), `--no-live` (don't rescan while open), and
`--theme auto|dark|light` (default `auto`). `NO_COLOR` turns colour off and
`FORCE_COLOR` forces it on.

**The view never uploads.** It only reads local data and updates the local
ledger (never shrinking a total). Only `sync`, with uploads on, talks to a server.

## What is stored and what leaves the machine

Only daily per-model token counters are uploaded — never prompts, answers,
file contents, or file paths. Locally, every adapter reads the same narrow
slice of each tool's files: counters, ids, model/provider ids, and
timestamps — never prompt or response text, tool output, or file/workspace
paths, even when they sit right next to a counter in the same record.

For Cursor specifically, the local event file
(`~/.tokengraph/cursor-events.jsonl`) keeps only: the model, the four token
counts, the turn's status, its generation id, the Cursor version, and a
timestamp. It never records prompts, answers, file paths, e-mail addresses,
or workspace paths — even though Cursor's hook payload includes some of
those.

## How counting works

- **Claude Code** dedups by `message.id`, taking the largest copy of a
  repeated line (Claude Code streams the same message to disk many times).
- **Codex CLI** dedups by `response_id`, across files — a forked or resumed
  session's rollout file can copy in records from an earlier one.
- **Cursor** dedups by `generation_id` (one agent turn), with a per-field max
  across repeated hook deliveries of the same turn.
- **Cursor's Claude slugs are normalised** to Anthropic's canonical model ids
  (e.g. `claude-4.5-opus-high-thinking` → `claude-opus-4-5`) so that model's
  usage from Cursor adds up together with its usage from Claude Code.
- **Cursor subagent tokens are not reported by Cursor** — only the parent
  agent's turn is visible locally, so subagent usage inside Cursor is not
  counted.
- **Gemini CLI** dedups by message `id` across files. It never records some
  side calls (web search, chat compression, model routing), so its daily
  totals are a lower bound on real usage, not an overcount. Gemini CLI also
  deletes sessions older than 30 days by default, so sync at least once a
  month to avoid losing history the way Claude Code's transcript pruning can.
- **Cline** dedups classic tasks by task id + timestamp and SDK sessions by
  message `id` across sessions (so a forked session isn't double-counted). It
  skips requests made through the `claude-code` provider (already counted by
  the Claude Code adapter) and messages imported from another tool, and skips
  Bedrock requests for non-Claude models, since Cline only estimates those
  token counts locally — `sync` reports how many of each it skipped. Tasks
  recorded before Cline 3.12 have no per-request model, so they're stored as
  `unknown`.
- **OpenCode** dedups by message `id` plus a fork fingerprint (id-only dedup
  misses OpenCode's own fork-copy mechanism). A message's `step-finish` parts
  are the actual request unit and are never summed with the message's own
  totals — that would double the count. Reading `opencode.db` needs Node
  22.13+ for its built-in `node:sqlite`; OpenCode's older JSON storage is read
  on any supported Node version. Records from before OpenCode 1.3.16 are only
  counted when their token fields can be interpreted with certainty; the rest
  are skipped and reported in `sync`'s notes rather than guessed. Title-generation
  calls (OpenCode's own naming-a-session request) are never recorded locally,
  so OpenCode's totals are a lower bound on real usage, not an overcount.
- **Claude models used through Gemini CLI, Cline, OpenCode, or Cursor show
  cost as unknown** — none of those tools record the 5m/1h cache-write split
  Anthropic's pricing needs, so the server can't price them, even though the
  token counts themselves are exact.
- **A model id that looks like a filesystem path or an AWS ARN** (starts with
  `/`, `~`, `arn:`, a Windows drive letter, or contains `/Users/` or `/home/`)
  is uploaded as `unknown` instead of verbatim — such a value is either a bug
  in the source tool or leaked local context, never a real model id.
- **Aider is not supported.** Its local chat history rounds token counts to
  the nearest thousand once they're over 10,000, and its one opt-in
  structured log (`--analytics-log`) reports estimated, not measured, counts
  whenever streaming is on (the default) and never separates cache reads from
  writes even with streaming off — there is no local record accurate enough
  to read.
- Cost estimates (in the terminal view, and on the server's dashboard) are
  approximate and shown as **unpriced** / **unknown** wherever no rate is
  recorded for a model, rather than being shown as $0.


## Environment variables

| Variable | Effect |
| --- | --- |
| `TOKENGRAPH_API_URL` | Default server URL, used when `login` isn't given `--api-url`. |
| `TOKENGRAPH_HOME` | Where the CLI keeps its config, ledger, and Cursor event file (default `~/.tokengraph`). |
| `CLAUDE_CONFIG_DIR` | Where Claude Code keeps its projects and settings (default `~/.claude`). |
| `CODEX_HOME` | Where Codex CLI keeps its sessions (default `~/.codex`). |
| `NO_COLOR` / `FORCE_COLOR` | Turn colour off / force it on in `tokengraph view`. |
| `TOKENGRAPH_NO_MOTION` | Set to `1` to skip the view's animations (same as `--no-motion`). |

## Command reference

```bash
tokengraph [view] [options]
tokengraph sync [options]
tokengraph login [options]
tokengraph logout
tokengraph status
tokengraph uploads [on|off]
tokengraph install-hook --agent <name> [options]
tokengraph schedule [options]
tokengraph --version
```

Every command takes `--help`. An option a command does not know is an error.

- `view` — the terminal dashboard (see "Terminal view"). Also what a bare
  `tokengraph` does in an interactive terminal.
  - `--print` — print a static snapshot and exit.
  - `--no-motion` — skip animations.
  - `--no-live` — don't rescan while open.
  - `--theme <auto|dark|light>` — colour theme (default `auto`).
- `sync` — reads local usage logs into the local ledger and, when logged in
  with uploads on, uploads daily totals.
  - `--since <days>` — how far back to read, 1–400 (default 90).
  - `--local` — update the local ledger only, without uploading. With no
    login, or with uploads off, `sync` stays local and exits 0 anyway.
- `login` — starts a device-code flow against the server and stores the
  resulting API key in `~/.tokengraph/config.json` (mode `0600`).
  - `--api-url <url>` — server to link with. A plain `http://` address other
    than this machine prints a warning, since the key would travel unencrypted.
  - `--no-open` — don't open the browser automatically.
  - `--new-device` — link this machine under a fresh device id (only needed
    when the server says this one belongs to another account).
- `logout` — removes the stored API key. Revoke the key itself from the
  server's settings page.
- `status` — the version, account, server, uploads setting, the local ledger,
  which hooks and schedule are installed (and whether the programs they run
  still exist), and when a hook last started a background sync.
- `uploads [on|off]` — with no argument, shows whether `sync` may upload from
  this machine; `on` / `off` sets it (see "Local mode").
- `install-hook` — wires tokengraph into a tool's own hook mechanism.
  - `--agent <claude-code|codex|cursor>` — which tool to install the hook for
    (required). `codex` writes a top-level `notify` into
    `$CODEX_HOME/config.toml` (default `~/.codex`) and leaves an existing
    `notify` that isn't tokengraph's untouched.
  - `--remove` — uninstall the hook instead of installing it.
    Re-running `install-hook` replaces a hook installed by an older version
    instead of adding a second one.
  - `--dry-run` — show the resulting settings file without writing it.
  - `--event <name>` — for `--agent claude-code` only: which Claude Code hook
    event to install on (default `SessionEnd`).
- `schedule` — installs an hourly background `sync --since 30` with the
  system scheduler, for tools without a hook and as a safety net for the
  ones that have one: a launchd agent (`dev.tokengraph.sync`) on macOS, a
  `crontab` entry (marked `# tokengraph-sync`) on Linux, a Task Scheduler
  task (`tokengraph-sync`) on Windows. Output goes to
  `~/.tokengraph/schedule.log`.
  - `--remove` — turn the hourly sync off again (uninstalls the schedule).
  - `--dry-run` — show what would be installed without changing anything.

## Uninstall

npm cannot run cleanup when a global package is removed, so take the hooks
and the schedule out first:

```bash
tokengraph install-hook --agent claude-code --remove
tokengraph install-hook --agent cursor --remove
tokengraph install-hook --agent codex --remove
tokengraph schedule --remove
npm uninstall -g tokengraph
```

Your ledger stays in `~/.tokengraph`; delete that folder too if you want
nothing left behind. Before the 0.1 release the CLI was called `token-graph`
and kept its data in `~/.token-graph`; the first run of `tokengraph` moves that
folder over.

## Adding support for another tool

Uploads are CLI-only by design — the server only accepts data that went
through an adapter here, so the leaderboard can't be fed by hand-written
requests. Claude Code, Codex CLI, Cursor, Gemini CLI, Cline and OpenCode are
wired up today (`packages/cli/src/adapters/`). Aider is not — see "How
counting works" above for why.

To add one:

1. Write an adapter under `packages/cli/src/adapters/<tool>/` that reads that
   tool's local usage logs and produces the same aggregate shape the
   existing adapters do (see `aggregator.ts` and `payload.ts`).
2. Add the tool's source string to `KNOWN_SOURCES` /
   `AGENT_CATALOGUE` in `packages/core/src/sources.ts`.
3. Add tests alongside the existing ones in `packages/cli/test/`.

Open a PR — happy to review adapters for new tools.

## Development

The source is an npm workspace: `packages/cli` is the command-line tool and
`packages/core` the shared logic it uses (usage aggregation, pricing, graph
rendering, the list of supported sources). The published package bundles
`core` into a single file.

```bash
npm install
npm run build                    # typecheck, then bundle packages/cli/bundle/bin.js
npm test
node packages/cli/bundle/bin.js --help
```

## License

MIT — see [LICENSE](./LICENSE), which also carries the notice for the
bundled Lobe Icons artwork.
