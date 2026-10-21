# Architecture

How tokengraph is put together. For what it is for and what it will not do, see
[product.md](product.md). For the rules that are easy to break when changing it, see
[CLAUDE.md](../CLAUDE.md). For how each agent stores its usage, see [agents/](agents/).

tokengraph has no server. Everything runs on the user's machine, and the only thing that leaves it
is what the user chooses to publish to their own GitHub gists.

## What runs where

Two npm workspaces in one repository:

- **`packages/core`** is pure calculation. It has no third-party runtime dependency and does no
  file or network I/O. It holds the token types and the weighted-token formula, pricing with dated
  rates, model names and families, the allowed source names, colour levels, the SVG graph
  renderer, and the data behind story cards.
- **`packages/cli`** is everything that touches the outside world: the agent adapters
  (`src/adapters/<agent>/`), the ledger, the terminal view (`src/tui/`), GitHub access
  (`src/github/`), publishing (`src/publish/`), story-card rendering (`src/story/`) and the phone
  hand-off server (`src/share/`).

The boundary rule: code that needs the file system, sockets, Satori or resvg belongs in the CLI.
A calculation belongs in core. Core is private and is inlined into the CLI bundle, which is the one
file npm ships (`bundle/bin.js`, plus `assets/`).

State lives in `~/.tokengraph/` (or `$TOKENGRAPH_HOME`): `config.json` (machine id, GitHub login and
auth, gist ids, graph colours, and `agentRoots`, the agent folders remembered from earlier runs;
mode 0600), `state.json` (the ledger, including the local-only hour tables), `machines.json` (the other
machines' files from the last publish) and, for Cursor, `cursor-events.jsonl`, `cursor-import.jsonl`
(rows imported from a dashboard CSV by `tokengraph import cursor`), `cursor-account-<accountKey>.jsonl`
(rows fetched from cursor.com, one file per account) and `cursor-fetch.json` (last attempt, back-off, how
far each account is covered; no secrets). None of the Cursor usage files is ever pruned.

## Data flow

```
agent logs ─► adapters ─► ledger (state.json) ─► publish ─► graph gist (public)
                                                      └───► data gist (secret)
```

1. **Adapters** read each agent's local logs, deduplicate the way that agent writes them, and
   return per-day, per-model token counts. `collect-local.ts` runs them for both `sync` and `view`.
2. **The ledger** merges each scan into `state.json`. Within one machine a total only grows: every
   field is merged with `max()`, so pruned transcripts never lower history.
   Before the adapters, a non-`--local` `sync` may fetch the signed-in Cursor user's history
   (`adapters/cursor/fetch.ts`: once an hour, a back-off after a failure) and folds the stored account
   files into the ledger.
3. **Publishing** runs only from `sync` (manual, a hook, or the schedule), `login` and
   `readme --colors`. It finds or creates two gists by a marker file name, never by id alone, so a
   second machine finds the same ones:
   - the **graph gist** (public) holds the rendered SVGs (dark, light, compact) and a `README.md`
     with the embed snippet;
   - the **data gist** (secret, so unlisted but readable by anyone with the URL) holds one
     `machine-<id>.json` per machine.
4. The README snippet points at the gist's **raw URLs** without a revision, so GitHub serves the
   latest file and updates show within minutes. The SVG renderer is deterministic (no timestamps),
   so the graph changes only when the data or the day does.
5. Writes are `PATCH`es containing only the files whose content differs from what the gist holds.
   When nothing changed, nothing is sent. A 404 on a cached gist id means the user deleted it: the
   id is forgotten and the gist recreated (for the graph gist the CLI says the snippet changed).

Network errors, a revoked token and rate limits never touch the local ledger.

## Machines

A machine file is `{ schema, machineId, label, fingerprint, cliVersion, updatedAt, sources }`,
where `sources` is the ledger body.

- **Machine id** is a random UUID kept in `config.json`. `logout` keeps it, so a machine never
  comes back under a new id and has its logs counted twice.
- **Label** is `<platform>-<first 6 of the id>`, such as `darwin-3f2a1c`. No hostname, which can
  carry a person's name.
- **Fingerprint** is a SHA-256 of the operating system's machine id and the user name. A machine
  with no id of its own but a matching fingerprint in the data gist adopts that id (a reinstall or
  a wiped `~/.tokengraph`) and gets its history back.
- **Within one machine**, the local ledger is max-merged with the machine's own file in the data
  gist before anything is written: that restores days the local ledger lost and never shrinks
  anything.
- **Across machines**, usage is summed per day, model and pricing tier. Different machines are
  different usage. A machine is never summed with itself.
- **An unreadable own file is never overwritten.** If the data gist has a file under this machine's
  name that does not parse, it may hold more than the local ledger, so the CLI skips writing it and
  reports it.
- **Hour data is local only.** Every adapter turns a request's instant into a local hour with the same
  `Intl` zone rule as its date (`hourKey` next to `dateKey` in core) and returns `CollectResult.hours`,
  weighted tokens summed per date and hour (each request weighted on its own; display-only, so it can differ
  by rounding from the day's weight). The ledger keeps them as `hours[source][date][hour]` and, for Cursor
  account rows, `accountHours[accountKey][date][hour]`, max-merged like the daily counts and written to
  `state.json` only. The machine file builder copies `sources` and `accounts` explicitly, so hours never
  reach a gist; a publish test searches every gist file for them. `combineMachineHours` in core applies the
  Cursor covered-day rule to hours (account hours on covered days, hook hours after, per-hour max on the
  boundary day). Hours exist only for days the logs still hold, so the view says where hour data starts.
- **A Cursor account is not a machine.** The history fetched from cursor.com covers every machine and
  surface of the account, so the ledger keeps it in a separate `accounts.cursor[accountKey] =
  { coveredThrough, days }` section (max-merged, carried by the machine file as an additive
  `accounts` field that older versions ignore). One pure function in core, `combineMachineUsage`,
  is the combining rule for the graph, the view, the story cards, `export --all-machines` and
  `status`: per account key the machines are merged by per-field max and different accounts are
  summed; account days are UTC days. The hook and import `cursor` source is ignored for days before
  the oldest `coveredThrough` among the accounts, and from that day on the larger of the summed
  accounts and the summed source is used per model. A machine whose account is never fetched anywhere loses its hook data on
  covered days (documented in `docs/agents/cursor-usage.md`).
- Other machines' files are cached in `machines.json`, so `story` and `view` can show
  all-machines numbers offline. The cache is rewritten only by a successful publish.

## Story cards

`tokengraph story` draws three PNGs (skyline, receipt, sticker) on the machine. The numbers come
from `packages/core/src/story/`. The layouts live in `packages/cli/src/story/` as JSX that
[Satori](https://github.com/vercel/satori) turns into SVG and `@resvg/resvg-wasm` rasterises. The
JSX uses the automatic runtime; `satori`, `resvg-wasm` and `react` are bundled by esbuild, not
runtime dependencies.

Assets (`resvg.wasm`, seven IBM Plex TrueType subsets and their licence) ship in
`packages/cli/assets/`. They are found through `assetsDir()` in `bin-path.ts`, which resolves the
same way from `bundle/` and from `dist/`. The design rules for the cards are in
[specs/2026-10-11-story-cards-design.md](specs/2026-10-11-story-cards-design.md).

The PNGs are saved to a folder: by default the OS's downloads folder (`src/downloads.ts`), read from
`user-dirs.dirs` on Linux, where its name is localised, and from the registry on Windows, where it
can be moved; then `~/Downloads`, then the home folder. Terminals with an inline image protocol
(iTerm2, WezTerm, Kitty, Ghostty) also show a preview; others show none, because character art of a
card is too coarse to be worth showing.

## The QR hand-off

After the cards are saved, `story` can serve them to a phone on the same Wi-Fi.

- The server binds to one private IPv4 address (10/8, 172.16/12 or 192.168/16), chosen from the
  non-virtual interfaces, on a random port. If there is none, the cards stay saved and nothing is
  served.
- Every URL sits under a 128-bit random token. Any other path is a bare 404, and does not count as
  activity. Only GET and HEAD are served.
- It serves one self-contained page and the PNGs from memory, never from disk, with
  `no-store` and a strict Content-Security-Policy.
- The terminal shows the URL as a QR code (`src/share/qr.ts`), two module rows per line. Matching
  halves are spaces painted with the background colour and mixed halves are `▄` over the top
  module's background, because terminals that draw block glyphs from the font (Apple Terminal)
  leave a strip between lines that only the background fills.
- It always stops: on Ctrl+C, 30 seconds after every card has been saved, or after 10 idle minutes.

## What never leaves the machine

- Prompts, answers, code, file names and paths are never read or stored. Adapters read counters and
  model names only.
- Nothing is sent to a tokengraph server, because there is none. The CLI talks only to GitHub
  (`api.github.com`, `github.com`, `gist.githubusercontent.com`) for the logged-in user and, while
  the Cursor fetch is on (the default once Cursor is signed in; `tokengraph cursor off`), to
  `cursor.com` to fetch the user's own usage export with Cursor's own sign-in. That token is read
  from Cursor's local database, held in memory for the request, sent to `cursor.com` and
  `www.cursor.com` only, and never stored, logged or printed.
- `status`, `view`, `story`, `export` and `import <file>` work offline from local files. `sync --local` never uses the
  network. `view` never publishes.
- The public gist exposes daily totals, model family names and colours, and never model ids or
  per-model counts. Those are only in the secret data gist.
- Without `login`, nothing is published at all.

## Authentication

`login` either reuses the GitHub CLI (`gh auth token`, if its token has the `gist` scope) or runs
GitHub's device flow with the project's OAuth App (device flow only, no client secret exists) for
the `gist` scope. With `gh`, only the path of `gh` is stored and the token is asked for at use
time, so scheduled runs with a minimal `PATH` still work and our file holds no copy of it.

## Where adapters look: roots

An agent's files can sit somewhere only the agent's own environment knows about: a profile named by
`CLAUDE_CONFIG_DIR` in a VS Code setting, `CODEX_HOME` in a shell profile, `XDG_DATA_HOME` in a dotfiles
setup. The hourly schedule (launchd, cron, Task Scheduler) gets none of that, and the ledger max-merges a
day's totals, so a profile only interactive runs see and a default folder only the schedule sees would be
max-merged instead of added. So every adapter scans the **union** of three kinds of root:

- **default** roots, computed from the home folder and the platform;
- **env** roots, named by the environment variables of the current run;
- **remembered** roots, saved in `config.json` under `agentRoots` (`{ [source]: string[] }`, additive: older
  versions ignore the key).

`src/agent-roots.ts` is the pure half. Each adapter has a `RootSpec` (`adapters/<agent>/roots.ts`) whose
`defaults`, `fromEnv` and `targets` take an injected `{ platform, env, home }` and never read `process.env`,
`os.homedir()` or `process.platform`, so the macOS, Linux and Windows branches are unit-tested on any machine.
Environment values are trimmed, an empty one is unset, a leading `~` is expanded, and a relative one is ignored
(no agent resolves one against the home folder, and the schedule's working directory is not the agent's). A
root is a plain string, usually the folder the agent keeps its data in; a prefix (`desktop:`, `sessions:`,
`editors:`, `server:`) marks the few roots that are shaped differently.

`planScan` turns roots into the files and folders to read and checks which exist. Targets that reach the
same real path (a symlinked profile, `CLAUDE_CONFIG_DIR` equal to `~/.claude`, a trailing slash, another
letter case) are listed once; a missing target is skipped silently by the adapters and shown as missing by
`status`. Adapters also skip a file they already read through another root (`FileDeduper`), which matters for
Codex rollouts that carry no `response_id`. Each adapter's dedup key (see CLAUDE.md) is what keeps a
session copied between roots from counting twice.

`agent-roots-store.ts` writes `agentRoots`: whenever `sync`, `view`, `status`, `schedule`, `install-hook` or
the Claude Code and Codex hook (`hook-sync`, which runs with the agent's own environment) runs with an
override in its environment that points at something that exists and is not already a default, the root is
added (atomically, mode 0600; never removed automatically). `status` and `status --json` list, per adapter,
every folder scanned, where the root came from (`default`, `env`, `remembered`) and whether it exists. Claude
Code's roots also include Claude Desktop's Code and Cowork session folders (`adapters/claude-code/desktop.ts`).

## Background syncs

`install-hook` makes an agent (Claude Code, Cursor, Codex, Gemini CLI) run the hidden `hook-sync` command (Gemini: a `SessionEnd` entry in `<GEMINI_CLI_HOME or home>/.gemini/settings.json`, foreign hooks and keys kept, `docs/agents/gemini-cli-usage.md`), which only spawns a detached
`sync`, so the hook returns instantly. `schedule` installs an hourly `sync --since 30` (launchd,
cron or Task Scheduler). Both take `~/.tokengraph/sync.lock`, so two syncs never run at once, and
`status` checks that the installed commands still point at an existing node and script. `status` also reports the log-retention policy of Claude Code, Gemini CLI and Qwen Code (`--json` for scripts). `uninstall` removes the hooks and the schedule; `--purge` also deletes only tokengraph's own files in the state folder (anything else there is kept), never the user's gists or the agents' logs.

## Invariants

The rules that are easy to break (dedup keys, totals that only grow, the weighted-token formula,
pricing tiers, what may be published) are listed in [CLAUDE.md](../CLAUDE.md) under "Invariants
that are easy to break".
