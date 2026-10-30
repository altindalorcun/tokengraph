# Changelog

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
