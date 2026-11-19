# Changelog

## Unreleased

- **Plan limits for Claude Code and Codex.** `tokengraph limits` shows how much of each plan limit window (five
  hours, seven days, thirty days) is used, when it resets and how old the reading is, exactly as the agents report
  it; a window that has reset shows no percentage until the next reading. Codex readings come from its session
  logs. Claude Code hands its readings only to its status line, so `tokengraph limits on` (or Claude Code limits
  in the Setup tab) wraps your status line: your own command keeps running and looks the same, and `limits off` or
  `uninstall` puts it back. The Overview tab shows the limits under the heatmap and `status` lists them.
  `tokengraph limits --json` gives menu bars and other tools the readings and today's totals without reading any
  agent logs. Readings stay on your machine and never go into a gist.
- **The Codex hook works when Codex's Computer Use is on.** Computer Use takes Codex's single `notify` setting, so
  Codex notify in the Setup tab stayed recommended and pressing it only flashed a cut-off error. tokengraph now
  leaves that `notify` alone and adds a `Stop` hook to `~/.codex/hooks.json` instead, which syncs after each turn.
  Codex runs a new hook only after you trust it, so installing it now shows the steps in a box: quit and reopen
  Codex, and when it asks "Hooks need review", press 2 ("Trust all and continue"), then Enter (Enter alone does not
  trust it); or type /hooks, select Stop, press Enter, then t. The hook is listed there as "tokengraph: sync usage".
  The Setup item is now called Codex hook; until Codex trusts it, it reads "trust it in Codex (Enter for steps)" and
  pressing it shows the steps again, and `status` points to them. When Codex hooks are turned off or Codex is older
  than 0.124, nothing is written, the item says why, and the hourly sync is recommended instead. `--remove` and
  `uninstall` take out only tokengraph's hook.
- **Merge projects from the Projects tab.** Select a project and press m: a box lists every other project, the
  ones that look like the same project first (`tokengraph-cli` and `tokengraph-site`, or a folder inside one named
  like the other). Type to filter, pick one, choose which name to keep, and Enter merges them. n renames the
  selected project and x splits a merged project back into one project per folder. The palette has all three.
- **`tokengraph projects merge` and `projects split`.** `projects merge <project> <into-project>` makes two projects
  one under the second one's name, and `projects split <project>` turns a merged project back into one project
  per folder. `merge` takes a name or a folder, like `projects name`; `split` takes the exact name or a folder path.
  Neither, nor `projects name`, changes the name of any other project.
- **A new folder no longer joins a project you named by chance.** A folder whose name matched a name you gave
  another project (say a new `other/cli` beside a project you named `cli`) used to be counted as part of it. It is
  now its own project, shown with its parent folder (`other/cli`). If a folder of yours was counted that way, it
  now shows as its own row; name it like the project to put it back.
- **Story cards stay inside the view.** Make story cards in the Setup tab used to leave the view for the
  plain terminal and ask you to press Enter to come back. It now opens a box in the view: pick the period,
  watch the cards being drawn, and scan the QR code shown beside them. Press S to also save the cards to
  your Downloads folder, and Esc to stop sharing and go back to Setup.
- **Every action stays inside the view.** Sync, Connect GitHub, Disconnect, the README snippet, graph
  colours, the Cursor fetch and CSV import, the exports, status, uninstall and update used to leave the
  view for the plain terminal and ask you to press Enter to come back. They now run in a box in the view:
  their output appears as it is printed, questions are asked in the box (type the CSV path, pick y or n),
  a spinner shows what a sync is doing, and ↑↓ / PgUp / PgDn scroll long output. Esc cancels Connect
  GitHub while it waits for your approval, and closes the box while it still waits for a scan. A command
  that cannot stop halfway keeps running, but pressing Ctrl-C twice quits tokengraph if one ever hangs.
  When it is done, Enter or Esc closes the box. After an update
  that installed a new version, closing the box starts the new one.
- **Key hints no longer stop mid-word.** When the bar at the bottom of the view is too narrow for every key,
  whole hints step aside (rescan and actions first) instead of the last one being cut, so `? help` and
  `q quit` always show.

## 0.2.4 — 2026-11-10

- **Story cards go to your phone first.** `tokengraph story` (and Make story cards in the view) now shows
  the QR code straight away instead of saving the PNGs to your Downloads folder first. Nothing is written
  to your computer unless you press S while the code is up, or pass `--save` or `--out <dir>`. `--no-qr`
  and runs without a terminal still only save the files.
- **Save on an iPhone goes to Photos, not Files.** Save used to download the card into Files. It now opens
  the card full screen and shows you to touch and hold it and tap Save to Photos, the one way Safari saves a
  picture from a page on your local network. On Android, Save still puts the card in your gallery in one tap.

## 0.2.3 — 2026-11-09

- **Claude Fable 5.2 and Claude Mythos 5.2 are priced.** Both launched on 2026-11-09 at $8 / $40 per million
  tokens, with cache reads at 0.025x ($0.20) and fast mode at 2x ($16 / $80), from Anthropic's pricing page.
  Every other Claude row on that page is unchanged.
- **Mythos usage from other agents is priced and merges with Claude Code's.** A Mythos model named the way
  Copilot, OpenRouter or Cursor write it (`claude-mythos-5.1`, `claude-mythos-5-1-thinking-high`) was stored
  as given and left unpriced. It is now stored as `claude-mythos-5-1`, like every other Claude model, and
  days recorded under the old names move to it when the ledger or another machine's file is read, so
  nothing is counted twice.

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
