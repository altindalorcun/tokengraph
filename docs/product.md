# tokengraph: product

## What it is

tokengraph turns the usage logs that AI coding agents already write to your disk into three
things:

- a **graph**: a GitHub-contribution-style heatmap of daily token usage, as an SVG you can put in
  your profile README;
- a **terminal view**: the same graph, plus totals, models, projects and estimated cost, right in
  your terminal;
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

It also answers "how much did this project cost me?". A team can get the same answer across people
without a server: everyone runs `tokengraph export --projects` and the team combines the files.

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
- **Token counts, and where they were burned.** tokengraph never reads, stores or sends prompts,
  answers or code. It notes the folder each session ran in, to total usage per project, and that
  stays on your machine. The public gist holds an SVG graph with family colours and names, never model
  ids or per-model counts (only daily totals), and never a project.
- **Publishing is opt-in and goes to you.** Your usage leaves your machine only when you choose
  to publish it, and it goes to gists on your own GitHub account. The two other network calls are
  the Cursor fetch, which asks cursor.com for your own Cursor usage, and the view's daily version
  check, which asks the npm registry for the latest version and sends no usage. Both can be turned off.

## Non-goals

- A hosted service, accounts or a sign-up flow.
- Invoices, budgets or quotas. The cost shown, per day or per project, is an estimate at public list
  prices, not what a subscription plan charges.
- Collecting prompts, code or anything beyond token counters and the folder a session ran in.
- Leaderboards or ranking people against each other. (A community wall built from pull requests
  may come later, see below; it would be opt-in and in the open.)
- Hosted team dashboards. Teams combine exports themselves.

## Ideas for later

- A community wall built from pull requests: people add themselves to a file in the repo.
- A public profile page rendered from a user's gist.
- A Homebrew formula.
