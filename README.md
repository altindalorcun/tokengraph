<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="tokengraph" src="docs/assets/logo-light.svg" height="56">
  </picture>
</p>

<h3 align="center">Your AI coding, as a GitHub-style graph.</h3>

<p align="center">
  <em>Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code and Goose: one graph, in your README.<br>
  Your usage never leaves your machine unless you publish it, and then only to your own gist.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokengraph"><img alt="npm version" src="https://img.shields.io/npm/v/tokengraph"></a>
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <b>English</b> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.zh-CN.md">简体中文</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ja.md">日本語</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ko.md">한국어</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.tr.md">Türkçe</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/graph-dark.svg">
    <img alt="A year of daily AI coding token usage as a contribution-style graph, coloured by model family" src="docs/assets/graph-light.svg" width="900">
  </picture>
</p>

## Quick start

```bash
npx tokengraph            # your graph, right in the terminal
npx tokengraph login      # publish it to your GitHub gist and get the README snippet
npx tokengraph story      # turn today into story cards and send them to your phone
```

Needs Node.js 22 or newer. To keep the README graph fresh without thinking about it:
`npm install -g tokengraph && tokengraph schedule`.

## Put it in your README

`tokengraph login` publishes your graph to a public gist on your GitHub account and copies this
snippet to your clipboard. Run `tokengraph readme` to print it again. Paste it into your profile
README (the `YOUR_LOGIN/YOUR_LOGIN` repository):

```html
<a href="https://github.com/altindalorcun/tokengraph">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-dark.svg">
    <img alt="My AI coding token usage, made with tokengraph" src="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-light.svg">
  </picture>
</a>
```

The graph switches between light and dark with the reader's GitHub theme. Every sync updates the
same gist, so the snippet never changes. Use `tokengraph readme --compact` for a smaller graph
without labels, and `tokengraph readme --colors single` for one colour instead of one per model
family (`--colors model` switches back). The families are Claude, GPT, Gemini, DeepSeek, Qwen,
GLM, Kimi, Grok, Composer (Cursor's own models), Mistral, Llama and MiniMax; every other model
counts as "Other models".

## Share your day

<p align="center">
  <img alt="Three story cards: a 3D skyline of the month, a receipt of the day's models, and a sticker with the day's total" src="docs/assets/story-strip.png" width="760">
</p>

`tokengraph story` draws three cards (a skyline, a receipt and a sticker) as PNG files sized for
Instagram and TikTok stories, then shows a QR code. Scan it with your phone on the same Wi-Fi and
save the cards straight to Photos. Nothing is uploaded anywhere: your computer serves the files to
your phone until you have saved the cards, or after 10 idle minutes. It asks which period to cover (today, 7 days, 30 days or 12 months); skip the question with `--range today|7d|30d|1y`, and leave
the estimated cost off with `--no-cost`.

## How it works

```
agent logs on your machine ──► tokengraph ──► ~/.tokengraph ledger ──► your gists
(Claude Code, Codex, …)        dedups,         (totals only grow)       public: the SVG graph
                               weights                                  secret: daily counts per machine
```

tokengraph reads the usage counters the agents already write to disk. It never reads your prompts
or answers. Each day's number is a weighted token count:

```
weighted tokens = input + output + cache writes + 0.1 × cache reads
```

Cache reads cost a fraction of fresh input, so they count a tenth. Without that, one long session
re-reading a big cached context would drown a day of real work. It measures work, not a bill.

- **No double counting.** Agents write the same message to disk several times while streaming,
  and resumed or forked sessions copy earlier records. tokengraph dedups by each agent's own
  message or response id, and never counts usage that another adapter already counts.
- **Totals only grow.** Agents delete old transcripts. The ledger keeps the largest count it has
  ever seen for each day, so history survives, and a fresh smaller scan never lowers it.

## Privacy

| | |
| --- | --- |
| **What leaves your machine** | To a public gist on your account: the SVG graphs (daily token totals and the names of the model families they are coloured by) and a README with the embed snippet and a link. To a secret gist on your account: per-day, per-model token counts, a random machine id, a label such as `darwin-3f2a1c`, a hashed machine fingerprint, the CLI version and the time of the last update. Both only after `tokengraph login`, and only when tokengraph publishes (`sync`, a hook, the schedule, or `login`). `sync --local`, `view`, `story`, `status`, `export` and `import` never do. |
| **What tokengraph fetches** | Only for Cursor, and only while it is on (the default once Cursor is signed in; `tokengraph cursor off` stops it): `sync` reads Cursor's own sign-in token from Cursor's local database (read-only, that one row) and asks cursor.com for your own usage export, the file the Cursor dashboard's export button gives you. The token goes to cursor.com only, is held in memory for the request and is never stored, printed or logged. What is kept is the usage rows (timestamps, model names, token counts). `sync --local` never does. |
| **What never does** | Prompts, answers, code, file names, paths. Nothing is sent to any tokengraph server: there is none. |
| **How to remove it** | `tokengraph logout` forgets the login on this machine. Delete the two gists on [gist.github.com](https://gist.github.com) to remove what was published. |

A secret gist is unlisted, not private: anyone who has its URL can read it. It holds the fields
listed above and never a hostname. Until
you run `tokengraph login`, nothing is sent anywhere.

## Supported agents

| Agent | Where it reads | Notes |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` and `transcripts` (also `$CLAUDE_CONFIG_DIR`), and the Code and Cowork sessions of the Claude desktop app (`~/Library/Application Support/Claude`, `%APPDATA%\Claude`, `~/.config/Claude`) | Claude Code deletes old transcripts, so sync at least every few weeks. `tokengraph install-hook --agent claude-code` syncs when a session ends. |
| Codex CLI | `~/.codex/sessions` and `archived_sessions` (also `$CODEX_HOME`) | `tokengraph install-hook --agent codex` syncs after a turn, at most every 10 minutes. It never overwrites a `notify` setting that is not its own. |
| Cursor | Your own usage history from cursor.com, fetched with Cursor's sign-in on this machine (`cursor-account-*.jsonl`); `~/.tokengraph/cursor-events.jsonl`, written by Cursor's `stop` hook, for real time | Cursor keeps no usable token counts on disk. When Cursor is signed in, `tokengraph sync` fetches your whole usage history from cursor.com by itself, at most once an hour (every machine, IDE, CLI and cloud agents; turn it off with `tokengraph cursor off`). The hook (`tokengraph install-hook --agent cursor`, then restart Cursor) fills in the hours before cursor.com has them; a usage CSV (`tokengraph import cursor <csv>`) works for people who keep fetching off. |
| Gemini CLI | `~/.gemini/tmp/*/chats`, and `~/.cache/.gemini/tmp` from the macOS sandbox (also under `$GEMINI_CLI_HOME`) | `tokengraph install-hook --agent gemini-cli` syncs when a session ends (Gemini CLI settings, also under `$GEMINI_CLI_HOME`); `tokengraph schedule` still covers it. Gemini CLI deletes sessions after 30 days by default, so sync at least monthly. It never records some side calls, so totals are a lower bound. |
| Cline | `saoudrizwan.claude-dev/tasks` in VS Code-family editors (VS Code, Cursor, VSCodium, Windsurf, Positron, Trae, Kiro, Antigravity and others; `$XDG_CONFIG_HOME` on Linux, `%APPDATA%` on Windows; remote `~/.vscode-server` and friends), and `~/.cline/data` (also `$CLINE_DIR`, `$CLINE_DATA_DIR`, `$CLINE_SESSION_DATA_DIR`) | Requests Cline sends through the Claude Code provider are skipped, because the Claude Code adapter already counts them. |
| OpenCode | `~/.local/share/opencode/opencode*.db` and the older `storage/` folder (also under `$XDG_DATA_HOME`; `$OPENCODE_DB` adds one database) | Reading the database needs Node 22.13 or newer. Records from before OpenCode 1.3.16 that cannot be read with certainty are skipped and reported. |
| Kilo CLI | `~/.local/share/kilo/kilo*.db` (also under `$XDG_DATA_HOME`; `$KILO_DB` adds one database) | Kilo Code 7.x in VS Code writes the same database, so it is counted here too. Reading the database needs Node 22.13 or newer. Records from before Kilo 7.2.6 that cannot be read with certainty are skipped and reported. |
| Copilot CLI | `~/.copilot/session-store.db` (also `$COPILOT_HOME`) | Needs Copilot CLI 1.0.70 or newer and Node 22.13 or newer. Only the CLI's own database is read, not the Copilot Chat extension in VS Code. A database with an unrecognised layout is skipped and reported. |
| pi | `~/.pi/agent/sessions` (also `$PI_CODING_AGENT_DIR`, and `$PI_CODING_AGENT_SESSION_DIR` if set) | Written the same way by `@mariozechner/pi-coding-agent` and its successor `@earendil-works/pi-coding-agent`. Forked sessions share earlier requests, which are counted once. Compaction and branch-summary calls name no model and are skipped and reported. |
| Qwen Code | `~/.qwen/projects` (`$QWEN_HOME`, `$QWEN_RUNTIME_DIR`), chats and background subagents | Chats forked with `/branch` copy earlier requests, which are counted once. Qwen Code does not record cache writes separately, so they count as ordinary input. It deletes background subagent transcripts after 30 days by default, so sync at least monthly. Its usage ledger, the only local record of the memory extractor's requests, is written only while `privacy.usageStatisticsEnabled` is true (the default); with it off, those requests are in no local file and only the chat requests are counted. |
| Goose | `~/.local/share/goose/sessions/sessions.db` (also under `$XDG_DATA_HOME` or `$GOOSE_PATH_ROOT/data`; `%APPDATA%\Block\goose\data` on Windows; every database found is read) | Reads the per-request usage ledger, so it needs a Goose version that has one, and Node 22.13 or newer. Usage from before the ledger existed has no known day or model and is skipped and reported. Sessions that drive Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI or pi through Goose are left out, because those agents' own logs already count them (for Cursor only if its hook fires for Goose's runs, which is unchecked). |

Each agent's counts are checked against real runs of Claude Code 2.1.304, Codex CLI 0.163.0, Gemini CLI 0.64.0, Cline 3.0.73, OpenCode 1.19.3, Kilo 7.8.15, Copilot CLI 1.0.100, pi 0.73.1, Qwen Code 0.25.3 and Goose 1.55.0 on every protocol they support, with [`scripts/e2e`](https://github.com/altindalorcun/tokengraph/blob/main/scripts/e2e/README.md). Cursor cannot be driven offline; its CSV parser was checked against real exports, its fetch against a local fake server and its hook format follows Cursor's documentation. Cline stores output tokens without the reasoning tokens some providers report inside them, so those are not counted.

Every agent is read from its default folder plus any folder its environment variable names, and tokengraph remembers such a folder
(in `config.json`) the first time a command runs with it set, so the hourly sync and the hooks, which do not get your shell's environment,
still read it. `tokengraph status` lists the folders it scans and whether they exist.

Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code and Goose have no hook (and Gemini CLI's is optional): `tokengraph schedule` syncs them every hour. Aider is
not supported, because its local history rounds token counts.

## Commands

Every command takes `--help`. An unknown option is an error.

| Command | What it does |
| --- | --- |
| `tokengraph [view]` | Opens the live terminal view: year heatmap, models, agents, streaks. `--print` prints a static snapshot. The default command in a terminal. |
| `tokengraph login` | Connects GitHub, publishes your graph to your own gist, prints the README snippet. Uses your GitHub CLI login if you have one (`--gh`), or a one-time code you approve in the browser (`--device`, `--no-open`). Asks for gist access only. |
| `tokengraph logout` | Forgets the GitHub login on this machine. Local data and your gists stay. |
| `tokengraph sync` | Reads every agent's logs into the ledger and, when logged in, publishes. With Cursor signed in it first fetches your Cursor usage from cursor.com (at most once an hour). `--since <days>` sets how far back to read (default 90), `--local` never touches the network. |
| `tokengraph readme` | Prints the README snippet and copies it. `--compact`, `--colors model\|single`. |
| `tokengraph story` | Draws story cards, saves the PNGs (to your Downloads folder unless `--out <dir>`) and offers to send them to your phone. `--template skyline\|receipt\|sticker\|all`, `--range today\|7d\|30d\|1y`, `--no-cost`, `--qr` / `--no-qr`, `--no-preview`, `--handle <name>`. |
| `tokengraph status [--json]` | Shows the GitHub account, the ledger, your machines, which background syncs are installed and healthy, the folders each agent is read from (and which exist), and how long Claude Code, Gemini CLI and Qwen Code keep their logs, with a warning when a short retention puts history at risk. `--json` prints it as one JSON object for scripts and AI agents. |
| `tokengraph install-hook --agent <claude-code\|cursor\|codex\|gemini-cli>` | Makes that agent start a background sync when it finishes. `--remove` uninstalls it, `--dry-run` shows what would change. |
| `tokengraph schedule` | Installs an hourly background sync: launchd on macOS, cron on Linux, Task Scheduler on Windows. `schedule --remove` turns it off. |
| `tokengraph export` | Writes your daily usage as CSV or JSON, one row per day, agent, model and pricing tier, with weighted tokens and estimated cost. `--format csv\|json`, `--out <file>`, `--since <date>`, `--all-machines`. Reads the ledger only. |
| `tokengraph cursor fetch\|on\|off` | Fetches your Cursor usage from cursor.com now (ignoring the hourly pause), or turns the automatic fetch on or off. `tokengraph import cursor --fetch` does the same as `cursor fetch`. `status` shows its state. If Cursor's sign-in has expired, open Cursor once. |
| `tokengraph import cursor <file.csv>` | Adds Cursor history by hand, for when fetching is off: download the usage CSV from the Cursor dashboard (Usage, export CSV) and pass it here. Importing the same or an overlapping file twice adds nothing twice. Import on one machine only: machines are added together, so the same file on two machines counts twice. Never publishes. |
| `tokengraph uninstall` | Removes the Claude Code, Cursor and Codex hooks and the hourly schedule. `--purge` also deletes tokengraph's own files in `~/.tokengraph` (ledger, login, logs, the Cursor event, import and fetched-account files) and keeps anything else there, `--yes` skips the question, `--dry-run` changes nothing. Your gists are never touched. |

Hooks and the schedule store the path of the installed program, so install tokengraph globally
(`npm install -g tokengraph`) before using them; both refuse to run from an `npx` cache.

## Several machines

Each machine writes its own file, `machine-<id>.json`, to the secret data gist. When you sync, the
graph is built from this machine plus every other machine's file, summed per day and model, so a
laptop and a desktop show up as one graph. The same files are a backup: after a reinstall or a
wiped `~/.tokengraph`, `tokengraph login` recognises your machine, restores its history and counts
nothing twice.

## FAQ

**Why gists?** They are free, they belong to you, GitHub serves and caches the images, and there
is no server for anyone to run, trust or shut down. If tokengraph disappears tomorrow, your graph
keeps working.

**Is the cost real?** It is an estimate at public API list prices, from a dated price table. It is
not what you were billed, which depends on your plan. A model with no known price is left out of
the total and marked unpriced, never counted as $0, so the total can only be a lower bound.
Prices are the vendor's published list price for Claude (Anthropic), GPT and o-series (OpenAI), Gemini
(Google), Grok (xAI) and Cursor's Composer 2.5. Open-weight models (DeepSeek, Qwen, Llama, Mistral,
MiniMax and the like) are deliberately left unpriced, since they have no single list price, and so is any
model whose vendor does not publish one (retired models, previews, Cursor's Auto).

**Why weighted tokens?** Raw totals are mostly cache reads, which are cheap and large. Counting
them at a tenth keeps the graph about work done. The formula is under [How it works](#how-it-works).

**Does it work offline?** Yes. `view`, `story`, `status`, `export`, `import <file>` and `sync --local` never use the network.
Only publishing needs GitHub, and the Cursor fetch (`sync`, `cursor fetch`) needs cursor.com.

**How do I stop?** `tokengraph uninstall` removes the Claude Code, Cursor, Codex and Gemini CLI hooks and the hourly
schedule; add `--purge` to also delete tokengraph's own files in `~/.tokengraph` (the ledger, the login, logs, and the Cursor event, import and fetched-account files). Anything else in that folder stays.
Then `npm uninstall -g tokengraph`. Your gists stay on GitHub until you delete them.

**Windows?** Paths, hooks and the hourly Task Scheduler job are written for Windows, but tokengraph
is developed on macOS and Linux, so expect rough edges and please open an issue.

## Contributing

Bug reports and pull requests are welcome; see [CONTRIBUTING.md](https://github.com/altindalorcun/tokengraph/blob/main/CONTRIBUTING.md). New agents
arrive as adapter PRs. What tokengraph is for, and what it will not do, is in the
[product notes](https://github.com/altindalorcun/tokengraph/blob/main/docs/product.md).

---

If tokengraph made your profile better, a ⭐ helps other people find it.

## License

MIT, see [LICENSE](https://github.com/altindalorcun/tokengraph/blob/main/LICENSE). Bundled third-party components: see
[THIRD-PARTY-NOTICES.md](https://github.com/altindalorcun/tokengraph/blob/main/packages/cli/THIRD-PARTY-NOTICES.md).
