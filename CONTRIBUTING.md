# Contributing to tokengraph

Thanks for helping. Bug reports, fixes and new agent adapters are all welcome. For the product's
direction and what it will not do, read [docs/product.md](docs/product.md) first.

## Setup

You need Node.js 22 or newer.

```bash
npm install
npx tsc --build                  # builds packages/core and packages/cli
npx vitest run                   # all tests
npx vitest run packages/core/test/pricing.test.ts      # one file
npx vitest run -t "test name substring"                # one test by name
node packages/cli/dist/bin.js view --print             # try the CLI you just built
node packages/cli/dist/bin.js sync --local             # never touches the network
```

Vitest resolves `@tokengraph/core` to its source, so tests need no build. The CLI at runtime
resolves it through `dist/`, so run `npx tsc --build` after changing core and before running the
CLI by hand.

## Project layout

| Path | What lives there |
|---|---|
| `packages/core` | Pure logic with no runtime dependencies and no file or network I/O: token types and the weighted-token formula, pricing with dated rates, model names and families, allowed sources, colour levels, the SVG graph renderer, story data. |
| `packages/cli` | Everything that touches the outside world: agent adapters (`src/adapters/<agent>/`), the ledger, the terminal view, GitHub publishing, story-card rendering, the QR share server. |
| `docs/agents/` | One note per agent describing how it stores usage locally. |
| `docs/specs/` | Design documents. |
| `scripts/` | Samples generator and font builders. |

The boundary rule: if code needs the file system, sockets, Satori or resvg, it belongs in
`packages/cli`. If it is a calculation, it belongs in `packages/core`.

## Adding an agent

An agent can be supported when its token usage sits in local files we can read reliably. Open a
"Support a new agent" issue first if you are unsure. The steps, in order:

1. **Document the log format.** Write `docs/agents/<agent>-usage.md`: where the files live on each
   OS, which environment variables move them, what a usage record looks like (with real samples,
   redacted of prompts, answers, paths and secrets), which fields are token counts, and how the
   tool writes the same message more than once. Look at the existing notes for the level of
   detail we expect.
2. **Register the source.** Add the source name to `KNOWN_SOURCES` in
   `packages/core/src/sources.ts`, and an entry to `AGENT_CATALOGUE` in the same file. Without
   it, the ledger rejects the adapter's usage.
3. **Write the adapter** in `packages/cli/src/adapters/<agent>/`, following an existing one (the
   Gemini CLI adapter is a good small example). Add it to `defaultAdapters()` in
   `packages/cli/src/collect-local.ts`. It must:
   - **dedup** the way the tool writes its logs: pick the key (message id, response id, task id
     plus timestamp) from your format note and apply it across files, not just within one;
   - **canonicalise model ids** through `canonicalModelId` in
     `packages/cli/src/adapters/model-ids.ts`, the only place provider decorations are
     stripped; unknown ids stay as recorded;
   - **set the pricing tier** per request (standard, long-context, fast), and leave the
     cache-write 5m/1h split `null` when the tool does not record it, never 0;
   - read only the files it needs, and never read or store prompts or answers.
4. **Add fixtures and tests** under `packages/cli/test/` (`<agent>-aggregator.test.ts` for the
   parsing and dedup, `<agent>-adapter.test.ts` for discovery). Build fixtures from the redacted
   samples in your format note and include the awkward cases: duplicated records, a session
   copied or resumed into a second file, a record without token counts.
5. **Check the totals against an independent count** and say how in the pull request: the tool's
   own usage report, a `jq` or SQL sum over the raw log, or a provider dashboard for a day you
   know. "The tests pass" does not show that the numbers are right.
6. **Never count usage another adapter already counts.** If the tool can run another agent as a
   subprocess or import its sessions (as Cline does with Claude Code), skip those records and
   explain how in the format note.

## Invariants

The rules that are easy to break are listed in [CLAUDE.md](CLAUDE.md) under "Invariants that are
easy to break": dedup keys, totals that only grow, the weighted-token formula, the pricing rules
(append a new dated entry, never edit an old rate), the hook and paths rules, and what may be
published. Read them before changing an adapter, the ledger or the pricing table.

## Tests never touch your machine's state

Tests must not read or write your real `~/.tokengraph`, and must not talk to the real GitHub.
`packages/cli/test/setup-home.ts` points `TOKENGRAPH_HOME` at a temporary folder (keep it in
`vitest.config.ts`), and network tests run against `test/fake-github.ts`. If you add a test that
needs either, use those.

## Pull requests and commits

- Keep a pull request to one concern; run `npx tsc --build && npx vitest run` before pushing.
- Commit messages are a short imperative sentence in plain English ("Read Gemini CLI chats from
  the sandbox cache"), with a body when the reason is not obvious.
- The pull request template asks how you checked the change; for adapters, that includes the
  independent count from step 5.
- By contributing you agree that your work is licensed under the project's [MIT licence](LICENSE).

## Reporting security problems

Not in a public issue; see [SECURITY.md](SECURITY.md).
