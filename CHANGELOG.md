# Changelog

## 0.1.0 — unreleased

The first public release.

- **A graph of your token use.** `tokengraph login` publishes a GitHub-style graph of the last
  year to a public gist on your own account and copies a README snippet for it. It follows the
  reader's light or dark theme, and each day is coloured by the model family that used most of it.
  `tokengraph sync`, the agent hooks and `tokengraph schedule` keep it current.
- **Several machines, one graph.** Each machine writes its own file to a secret gist on your
  account. Machines are summed into one graph, and a reinstalled machine gets its history back.
- **Terminal view.** Running `tokengraph` in a terminal shows a year heatmap, models, agents and
  streaks, reading local logs only.
- **Story cards.** `tokengraph story` draws three Instagram and TikTok story cards (skyline,
  receipt and sticker) on your machine and can send them to your phone with a QR code over the
  local network.
- **Agents.** Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI,
  pi, Qwen Code and Goose. Claude Code, Codex and Cursor can start a background sync when they
  finish; the others are picked up by the hourly schedule.
- **No usage missed by where an agent keeps its files.** Every agent is read from its default folder,
  the folder its environment variable names and the folders remembered from earlier runs (so the
  hourly sync still reads a profile set only in your shell), including Claude desktop's Code and
  Cowork sessions. `tokengraph status` lists the folders it scans and which exist.
- **Retention warnings.** `tokengraph status` shows how long Claude Code, Gemini CLI and Qwen Code
  keep their logs and warns when history is at risk. `status --json` prints it for scripts.
- **Export.** `tokengraph export` writes daily usage as CSV or JSON from the local ledger.
- **Cursor import.** `tokengraph import cursor <csv>` adds history from a Cursor dashboard export.
- **Uninstall.** `tokengraph uninstall` removes the hooks and the schedule. `--purge` also deletes
  tokengraph's own files and nothing else.
- **Older versions.** An older tokengraph version ignores the new agents' sources; going back to an older version on the same machine drops them from that machine's ledger on its next sync.
- **No server.** Nothing is sent to a tokengraph server, because there is none. Prompts, answers,
  code and file names are never read.
