# Changelog

## 0.2.2 — 2026-11-08

- **One way to write a token count, everywhere.** A story card could print "1000M" for a total just under a
  billion, and its big number dropped the decimal the README graph showed ("713M" beside "713.4M"). The
  cards, the README graph and the terminal view now write every count the same way: one decimal, the next
  unit as soon as the figure would reach 1000 ("1.0B", never "1000M"), and no upper limit (on to T and Q,
  where a trillion used to read "1000.0B").

## 0.2.1 — 2026-11-03

- **`npx tokengraph login` can turn on the hourly sync.** The schedule needs a lasting install, so after
  the first publish a copy run through `npx` now offers to install tokengraph globally with npm
  (the same version) and then turns the schedule on from that copy. It asks first, and a no or an npm
  error prints the command to run yourself, with a pointer to npm's guide for permission errors.
- **Marks for five more agents.** Kilo CLI, Copilot CLI, pi, Qwen Code and Goose now show their logo in the
  terminal view and the README graph's legend, like the other six.

## 0.2.0 — 2026-11-01

- **Update notice.** The terminal view asks npm for the latest version once a day in the background.
  When a new one is out it says so in the status bar, and `u` installs it and reopens the view.
  Offline it stays silent, and the view never waits for the answer. Other commands you type show one
  line about it, from what the view last found, without touching the network.
- **Usage per project.** The new Projects tab shows tokens, share and estimated cost per project, with the
  selected project's models and agents, and Models and Agents show each row's top projects. Insights moves
  to key 5 and Setup to key 6. `tokengraph projects` prints the same, `projects show <name>` adds a project's
  folders, and `tokengraph export --projects` writes one row per day, project, agent, model and tier.
  A project is a git repository, or the folder a session ran in when there is none. Numbers start from the logs
  still on disk; usage with no known project, such as cursor.com's history, is the Not assigned row. Project
  data stays on this machine: nothing about it reaches a gist, the graph or a story card.
- **Merge folders into one project.** `tokengraph projects name cli tokengraph` renames a project, and folders
  with the same name count as one.
- **`tokengraph update`** shows the npm command and asks before installing. `--yes` skips the
  question. A copy run through `npx` or installed some other way is left alone and you get the
  command to run. `tokengraph update off`, `TOKENGRAPH_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`
  stop the daily check, which sends no usage data.

## 0.1.1 — 2026-10-30

- The npm page now links to [tokengraph.app](https://tokengraph.app).
- The README shows the terminal view in a short demo, and the FAQ explains how tokengraph differs
  from ccusage and tokscale.

## 0.1.0 — 2026-10-26

The first public release.

- **A graph of your token use.** `tokengraph login` publishes a GitHub-style graph of the last
  year to a public gist on your own account and copies a README snippet for it. It follows the
  reader's light or dark theme, and each day is coloured by the model family that used most of it.
  `tokengraph sync`, the agent hooks and `tokengraph schedule` keep it current. The graph carries a
  strip of five figures (today, the current and longest streak, the best day, active days, and the
  family that led the most days). It draws itself in once and marks today with a soft pulse, and it
  stays still when the reader prefers reduced motion.
- **Several machines, one graph.** Each machine writes its own file to a secret gist on your
  account. Machines are summed into one graph, and a reinstalled machine gets its history back.
- **Terminal view.** Running `tokengraph` in a terminal shows a year heatmap, models, agents,
  streaks, the estimated cost and what prompt caching saved you, all from local logs. Claude
  models appear by name and version. The Insights tab says in a sentence which part of the day you
  use AI in, with one bar per hour (← → or the mouse picks one), and shows your busiest weekday.
- **Setup tab and command palette.** The view's fifth tab manages this machine: the GitHub account,
  a hook for each agent that has one (Claude Code, Cursor, Codex, Gemini CLI), the hourly sync,
  Cursor history, story cards, export, status and uninstall. `:` or Ctrl-K opens a palette with the
  same actions, `h` on the Agents tab manages hooks, and every action shows its CLI equivalent. The
  view publishes only when you pick Sync, login or graph colours in it.
- **Story cards.** `tokengraph story` draws three Instagram and TikTok story cards (skyline,
  receipt and sticker) on your machine and can send them to your phone with a QR code over the
  local network.
- **Agents.** Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI,
  pi, Qwen Code and Goose. Claude Code, Codex, Cursor and Gemini CLI can start a background sync when
  they finish (`tokengraph install-hook --agent gemini-cli` adds a `SessionEnd` hook to Gemini's
  settings without touching other hooks); the others are picked up by the hourly schedule.
- **No usage missed by where an agent keeps its files.** Every agent is read from its default folder,
  the folder its environment variable names and the folders remembered from earlier runs (so the
  hourly sync still reads a profile set only in your shell), including Claude desktop's Code and
  Cowork sessions. `tokengraph status` lists the folders it scans and which exist.
- **Counts checked against real agents.** Claude Code, Codex CLI, Gemini CLI, Cline, OpenCode, Kilo CLI,
  Copilot CLI, pi, Qwen Code and Goose were run for real against a fake LLM server (`scripts/e2e`), and the
  tokens tokengraph counted matched what the server sent, on every protocol each agent supports. Cursor cannot
  be driven offline.
- **Retention warnings.** `tokengraph status` shows how long Claude Code, Gemini CLI and Qwen Code
  keep their logs and warns when history is at risk. `status --json` prints it for scripts.
- **Export.** `tokengraph export` writes daily usage as CSV or JSON from the local ledger.
- **Busiest hour.** Every agent's requests are also bucketed by local hour of day. The Insights tab shows your
  busiest hour and when you code; `view --print` has a Busiest hour line;
  `tokengraph export --hours` writes the hour rows. Hour data stays in `state.json` on this machine, never in
  a gist, and starts from the oldest day your agents' logs still hold.
- **Cursor import.** `tokengraph import cursor <csv>` adds history from a Cursor dashboard export.
- **More models priced.** OpenAI's nano, codex, GPT-4.1/4o and o-series models, Google's Gemini models and xAI's
  Grok models now have list prices, with each vendor's own long-context threshold (200K for Gemini and xAI, 272K for
  OpenAI) and no invented fast price where the vendor publishes none. Cursor's slugs are matched to them
  (`gpt-5.5-extra-high` is `gpt-5.5`, `cursor-grok-4.5-medium` is `grok-4.5`). Open-weight models and models
  without a published price stay unpriced.
- **Cursor history by itself.** When Cursor is signed in, `tokengraph sync` fetches your own usage history from
  cursor.com (the export the dashboard offers), using Cursor's sign-in read from its local database. The sign-in
  is held in memory for the request and never stored or printed; the first manual sync says what it does.
  It covers every machine and surface of the account, so it is counted once across machines and replaces hook
  and imported rows on the days it covers. Fetches are at most hourly, pause after an expired sign-in or a rate
  limit, and `tokengraph cursor off` turns them off. `tokengraph cursor fetch` (or `import cursor --fetch`)
  fetches now, and `status` shows the state. The first fetch is split into windows of at most 31 days, fetched
  one after another; if one fails, what was stored is kept and the next run resumes there.
- **Uninstall.** `tokengraph uninstall` removes the hooks and the schedule. `--purge` also deletes
  tokengraph's own files and nothing else.
- **No server.** Nothing is sent to a tokengraph server, because there is none. Prompts, answers,
  code and file names are never read.
