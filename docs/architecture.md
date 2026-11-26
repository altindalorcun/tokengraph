# Architecture

How tokengraph is put together. For what it is for and what it will not do, see
[product.md](product.md). For the rules that are easy to break when changing it, see
[CLAUDE.md](../CLAUDE.md). For how each agent stores its usage, see [agents/](agents/).

tokengraph has no server. Everything runs on the user's machine. Usage leaves it only when the user
chooses to publish it to their own GitHub gists; the two other network calls are the Cursor fetch,
which asks cursor.com for the user's own usage, and the view's daily version check to the npm
registry, which sends no usage (see Privacy below).

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
far each account is covered; no secrets). None of the Cursor usage files is ever pruned. `limits.json`
holds the Claude Code limit readings (see Plan limits below); local only.

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

A machine file is `{ schema, machineId, label, fingerprint, cliVersion, updatedAt, sources, accounts? }`,
where `sources` is the ledger body and `accounts` the Cursor accounts this machine fetched from
cursor.com (`accounts.cursor[accountKey] = { coveredThrough, days }`).

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
- Other machines' files are cached in `machines.json`, so `story`, `status`, `export --all-machines`
  and `view` can show all-machines numbers offline. The cache is rewritten only by a successful
  publish, and read only while logged in. The view opens on every machine (`a` or `--this-machine`
  narrows it), says how old the cache is under the mode pill and re-reads it after any action; its
  Setup recommendations, hours and projects stay this machine's
  ([specs/2026-11-26-view-all-machines.md](specs/2026-11-26-view-all-machines.md)).

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

In the view, Make story cards does not hand the terminal to the command. It opens a box
(`src/tui/story-panel.ts`, drawn by `views/story.ts`) that asks for the period, then runs
`src/tui/story-session.ts`: the same drawing, saving and server code as `tokengraph story`
(`renderStoryCards`, `writeStoryCards`, `storyOutDir` in `commands/story.ts`), reporting through
events instead of stdout. The code is drawn into the frame in black and white whatever the theme;
when the window is too small for it, the box asks for a bigger one and prints the address. S saves,
Esc (or Ctrl+C) stops the server and closes the box. While the box is open it counts as a running
action, so the view's scans wait until it closes.

No other action leaves the view either. Toggles (hooks, the hourly sync, the Cursor fetch) run behind it
and report with a toast. Everything else (sync, login, logout, the README snippet, graph colours, the
Cursor fetch and import, the exports, status, uninstall and update) runs in the task box
(`src/tui/task-panel.ts` for its state and keys, `views/task.ts` to draw it, `src/tui/task-session.ts`
to run the command, `taskRun` in `run-action.ts` for what each action calls). The command is the same
code the CLI runs; while it runs, the session points three module-level hooks at the box and puts them
back when it ends:

- `console.*` is replaced, so every line reaches the box as it is printed, with colours, cursor moves,
  `\r` redraws and other control characters stripped (`cleanLine`).
- `setPromptHandler` in `prompt.ts` sends `askYesNo`, `askText` and `askChoice` to the box (a y/n
  question, an editable line, a list), however deep in a command they are asked. Esc answers as cancel.
- `setSpinnerRedirect` in `spinner.ts` turns the spinner of a sync (also inside login and graph colours)
  into the box's busy line instead of frames on stderr.

Nothing in those code paths writes to `process.stdout` or `process.stderr` itself (`export --out`
reports through the console), and child processes they start (`npm install -g` for update and for the
install login may offer, the installed copy's `schedule`) get piped output that is forwarded to the box
line by line (`child-output.ts`), never the terminal. Output is narrowed to one column per character
(`text-width.ts`: wide characters get a stand-in, combining marks fold or go), because the screen buffer
holds one character per cell and a two-column one would push the border out of line. While the box is
open it takes every key. Before the command has started (it waits for a scan or ledger write in flight)
Esc closes the box. Esc stops a running command only where stopping is safe (login while it waits for
GitHub's approval, through an `AbortSignal` into `pollForToken`, which also refuses a token that arrives
after the abort); elsewhere the box says it cannot stop halfway. One Ctrl+C never quits mid-command, but a
second within two seconds does (exit 130), so a command that hangs can always be left; the session's
overrides are put back and the terminal restored. An Enter, y, n or digit within 150 ms of a question
opening was typed for the previous one and is ignored. When the command ends the box shows Done, Failed
or (after a cancel) Cancelled, and stays until Enter or Esc. Closing it
reloads the ledger, the mode, the hooks and the config and restarts the scans; after an update that
installed a new version it ends the view so `commands/view.ts` starts the new one, and after an
uninstall that deleted the data it ends the view, since a rescan would write a new ledger.

## Plan limits

`tokengraph limits`, `status`, the Overview tab and `limits --json` show how much of each Claude Code and
Codex plan limit window is used (terms in [GLOSSARY.md](../GLOSSARY.md)). Only what the agents report is
shown; nothing is estimated from token counts.

- **Codex** writes its readings into every `token_count` event of its rollouts. `src/limits/codex.ts` reads
  the 8 most recently modified rollout files on demand and keeps the newest reading per `limit_id`
  (`docs/agents/codex-usage.md`). Nothing is stored.
- **Claude Code** passes its five-hour and seven-day readings only to its `statusLine` command
  ([ADR 0001](adr/0001-claude-limits-via-statusline.md)). `tokengraph limits on` (or the Setup toggle) stores
  the user's `statusLine` object whole in `config.json` (`claudeStatusline.previous`) and installs the hidden
  `statusline` command (`claude-statusline.ts`, `commands/statusline.ts`). It saves the reading to
  `limits.json` (atomic, only on change, every error silent) and runs the previous command through the shell
  with the same stdin, passing its stdout and exit code through. It prints nothing of its own, never writes
  to stderr, never chains to itself and runs no adapter or ledger code. `limits off` and `uninstall` write the
  previous object back exactly, and leave a `statusLine` that is no longer ours alone.
- **Limit hits**: a transcript record with `apiErrorParams.rate_limit_info` (`status: "rejected"`) is a
  100% reading of that window at its timestamp. The Claude Code aggregator returns the newest per window in
  `CollectResult.limits`; `sync` and the view store it when it is newer than the stored window.
- `limitViews` in core turns readings and the current time into what every surface shows: labels (`5h`,
  `7d`, `30d`), a level (good below 70%, warn from 70%, bad from 90%), the age, and `reset` once `resetsAt`
  has passed, when the share is shown as unknown, never as 0%.
- `limits --json` (schema 1, fields only ever added) adds today's weighted tokens and cost from the ledger.
  It runs no adapter, so a menu bar can poll it.

## What never leaves the machine

- Prompts, answers, code, file names and paths are never read or stored. Adapters read counters and
  model names only.
- Plan limit readings stay in `limits.json` and memory. They never go into a machine file or a gist, and
  reading them makes no network call.
- Nothing is sent to a tokengraph server, because there is none. The CLI talks only to GitHub
  (`api.github.com`, `github.com`, `gist.githubusercontent.com`) for the logged-in user and, while
  the Cursor fetch is on (the default once Cursor is signed in; `tokengraph cursor off`), to
  `cursor.com` to fetch the user's own usage export with Cursor's own sign-in. That token is read
  from Cursor's local database, held in memory for the request, sent to `cursor.com` and
  `www.cursor.com` only, and never stored, logged or printed.
- `status`, `view`, `story`, `export` and `import <file>` work offline from local files. `sync --local` never uses the
  network. `view` publishes only when the user
  picks Sync, login or graph colours in its Setup tab or palette; opening and scanning never do.
- Adapters read the folder each session ran in, for per-project totals. It is stored in `state.json` under `projects`,
  next to the hour data and just as local: machine files list their fields explicitly, so it never reaches a gist, the
  graph or a story card. `export --projects` writes project names, never paths, and only when asked. Grouping happens
  when reading (`project-usage.ts`): folder to git root (`project-roots.ts`, which reads `.git` and never starts `git`),
  root to name, and roots with one name are one project. Names live in `config.json`. Usage with no known folder, and
  anything the folders do not reach, is the Not assigned row, so projects always add up to the view's total.
- A name made up from a folder never equals a name the user gave (it moves on to `parent/folder`, then a hash), so a
  new folder cannot join a named project by chance. Merging, renaming and splitting projects only rewrite the user's
  names (`project-names.ts`, pure): a merge gives every root of both projects one name, a split removes the names of a
  project's roots. `settleNames` keeps every other project where it is: a name another project shows is written to its
  roots too, and a root whose made-up name would change gets its current one. It also ranks the projects a merge is
  likely to want (same name once case, separators and parts like `-cli` are ignored; a parent folder named like the
  other; one name inside the other; folders side by side in a small folder that is not right under home). `projects merge|split` and the view's Projects tab share
  it through `editProjects` in `commands/projects.ts`, which reads the config right before it writes it. In the view,
  m, n and x open a box (`src/tui/project-panel.ts`, drawn by `views/project-panel.ts`); applying an edit holds the
  view like an action: a scan in flight finishes first, the names are read again, and only then do scans resume.
- The view, and only the view, asks `registry.npmjs.org/tokengraph/latest` for the latest version, at most once a day and
  in the background (`update-check.ts`). The answer is kept in `update-check.json`. A failure is silent, nothing ever
  waits for it, and other commands only read that file. `tokengraph update off`, `TOKENGRAPH_NO_UPDATE_CHECK`,
  `NO_UPDATE_NOTIFIER` and `CI` stop it. `tokengraph update` asks npm itself and runs `npm install -g` only for a copy
  inside npm's global folder, after a yes; the version it installs must match a plain `x.y.z`. A prerelease is never offered.
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
the Claude Code, Codex and Gemini CLI hook (`hook-sync`, which runs with the agent's own environment) runs with an
override in its environment that points at something that exists and is not already a default, the root is
added (atomically, mode 0600; never removed automatically). `status` and `status --json` list, per adapter,
every folder scanned, where the root came from (`default`, `env`, `remembered`) and whether it exists. Claude
Code's roots also include Claude Desktop's Code and Cowork session folders (`adapters/claude-code/desktop.ts`).

## Background syncs

`install-hook` makes an agent (Claude Code, Cursor, Codex, Gemini CLI) run the hidden `hook-sync` command (Gemini: a `SessionEnd` entry in `<GEMINI_CLI_HOME or home>/.gemini/settings.json`, foreign hooks and keys kept, `docs/agents/gemini-cli-usage.md`) (Codex: its single `notify` when free, otherwise a `Stop` entry in `$CODEX_HOME/hooks.json` that Codex runs once the user trusts it (a startup prompt, or `/hooks`); never another program's `notify`, nothing written when Codex hooks are off or Codex is too old, `docs/agents/codex-usage.md`), which only spawns a detached
`sync`, so the hook returns instantly. `schedule` installs an hourly `sync --since 30` (launchd,
cron or Task Scheduler). Both take `~/.tokengraph/sync.lock`, so two syncs never run at once, and
`status` checks that the installed commands still point at an existing node and script. `status` also reports the log-retention policy of Claude Code, Gemini CLI and Qwen Code (`--json` for scripts). `uninstall` removes the hooks and the schedule, and puts back the Claude Code status line if `limits on` wrapped it; `--purge` also deletes only tokengraph's own files in the state folder (anything else there is kept), never the user's gists or the agents' logs.

## Invariants

The rules that are easy to break (dedup keys, totals that only grow, the weighted-token formula,
pricing tiers, what may be published) are listed in [CLAUDE.md](../CLAUDE.md) under "Invariants
that are easy to break".
