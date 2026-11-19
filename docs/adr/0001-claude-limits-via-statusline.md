# Claude Code limit readings come from a statusline wrapper

Claude Code writes no limit readings to its transcripts; it only records a limit when a request is
refused (`rate_limit_info` on a 429). The live five-hour and seven-day readings reach the `statusLine`
command on stdin (`rate_limits.five_hour` and `rate_limits.seven_day`). So, when the user turns it on,
tokengraph installs `tokengraph statusline` as that command. It saves the reading under `~/.tokengraph/`
and passes the same stdin to the command the user had before, printing that command's output unchanged.
The 429 records in transcripts are kept as a fallback.

## Considered options

- **The OAuth usage endpoint** that Claude Code's own usage screen calls. Rejected: it is undocumented,
  it needs the user's Claude token from the Keychain, and it would add a network call and a new host to
  the privacy list. Its one advantage, seeing usage from claude.ai and other machines straight away, does
  not outweigh that.
- **429 records only.** Rejected as the main source: they say only that a limit was hit, never how close
  the user is to one.

## Consequences

- `statusLine` holds a single command, like Codex `notify`. tokengraph never drops a command that is not
  its own: it stores that command in `config.json`, wraps it, and writes it back unchanged on removal.
  If the setting has changed in the meantime, removal leaves it alone.
- A reading is only as fresh as the last statusline refresh. Usage on claude.ai or on another machine
  shows up after the next local turn, so every reading is shown with its age. A window whose reset time
  has passed is shown as reset with no new reading, never as 0%.
- A project whose own `.claude/settings.json` sets `statusLine` bypasses the wrapper, so no readings are
  taken there.
- Limit readings stay on the machine. They never go into a gist.
- Claude Code fills `rate_limits` only for a claude.ai sign-in. Checked on 20 November 2026 with Claude Code
  2.1.329 in a pseudo-terminal against a fake server sending the `anthropic-ratelimit-unified-*` headers with
  an API key: the wrapper ran the user's command with the same stdin and its line showed unchanged, `limits off`
  restored the setting exactly, and the status line input carried no `rate_limits`. The field names
  (`five_hour` and `seven_day`, each with `used_percentage` and `resets_at`) come from Claude Code's own
  status line documentation and code. On a gateway sign-in it also sends `spend_limit`, which tokengraph shows as a
  window of unknown length.
