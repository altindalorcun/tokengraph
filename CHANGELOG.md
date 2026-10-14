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
- **Agents.** Claude Code, Codex CLI, Cursor, Gemini CLI, Cline and OpenCode. Claude Code, Codex
  and Cursor can start a background sync when they finish.
- **No server.** Nothing is sent to a tokengraph server, because there is none. Prompts, answers,
  code and file names are never read.
