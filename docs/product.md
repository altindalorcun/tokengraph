# tokengraph: product

## What it is

tokengraph turns the usage logs that AI coding agents already write to your disk into three
things:

- a **graph**: a GitHub-contribution-style heatmap of daily token usage, as an SVG you can put in
  your profile README;
- a **terminal view**: the same graph, plus totals, models and estimated cost, right in your
  terminal;
- **story cards**: PNGs sized for Instagram and TikTok stories, drawn on your machine and handed
  to your phone with a QR code.

It is local-first. There is no tokengraph server, no account and no database. The CLI reads local
files, keeps a ledger in `~/.tokengraph/`, and, only if you run `tokengraph login`, publishes the
graph to a public gist on your own GitHub account.

## Who it is for

Anyone who codes with AI agents and would like to see (and show) how much they use them. A tool is
supported only when its usage can be read reliably from local data. If an agent keeps no usable
token counters on disk, we do not guess; see the per-agent notes in [`docs/agents/`](agents/) for
how each supported tool stores its data.

## What success looks like

1. People put the graph in their profile README.
2. People share story cards.
3. GitHub stars and adapter contributions: other people add the agents we do not cover yet.

None of this counts if the numbers are wrong. A graph that overstates a day, or loses a week when
an agent prunes its logs, is worse than no graph. So:

- **Totals only ever grow.** Agents delete old transcripts; the ledger merges every sync with a
  per-field maximum, so a smaller fresh count never replaces a stored one.
- **Every adapter dedups the way its tool writes logs** (by message id, response id and so on)
  and is checked against an independent count before it ships.
- **Unknown is shown as unknown.** A model with no known price is left out of the cost total and
  marked unpriced, never counted as $0. A cache-write split we cannot see is `null`, never 0.

## Principles

- **Tool-neutral.** The graph is coloured by model family, not by agent. No tool is favoured.
- **Open source.** MIT-licensed, and everything that runs is in this repository.
- **Local-first and free to run.** Nothing the project pays for scales with its users.
- **Token counts only.** tokengraph never reads, stores or sends prompts, answers or code. The
  public gist holds an SVG graph with family colours and names, never model ids or per-model counts (only daily totals).
- **Publishing is opt-in and goes to you.** The only thing that leaves your machine is what you
  choose to publish, and it goes to gists on your own GitHub account.

## Non-goals

- A hosted service, accounts or a sign-up flow.
- Billing, quota or spend tracking. The cost shown is an estimate at public list prices.
- Collecting prompts, code or anything beyond token counters.
- Leaderboards or ranking people against each other. (A community wall built from pull requests
  may come later, see below; it would be opt-in and in the open.)
- Team dashboards.

## Ideas for later

- A community wall built from pull requests: people add themselves to a file in the repo.
- A public profile page rendered from a user's gist.
- A Homebrew formula.
