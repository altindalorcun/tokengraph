# CLAUDE.md

tokengraph is a GitHub-contribution-style heatmap of daily AI coding agent token usage (Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode). It is **local-first and has no server**: the CLI reads each agent's local logs, keeps a ledger on the machine, and publishes the README graph as SVG files to the user's own public GitHub gist; a secret gist holds every machine's ledger so machines merge and history survives a reinstall. Story cards (Instagram/TikTok PNGs) are rendered on the machine and handed to the phone with a QR code over the local network.

`docs/product.md` holds the vision and non-goals. Design notes: `docs/architecture.md`; per-agent log formats: `docs/agents/`.

## Commands

```bash
npm install
npx tsc --build                     # build packages/core + packages/cli
npx vitest run                      # all tests
npx vitest run packages/core/test/pricing.test.ts
npx vitest run -t "test name substring"
node packages/cli/dist/bin.js sync --local      # never touches the network
node packages/cli/dist/bin.js view --print
cd packages/cli && npm run build    # tsc, then esbuild bundle → packages/cli/bundle/bin.js (what npm ships)
cd packages/cli && npm pack
```

Vitest aliases `@tokengraph/core` to `packages/core/src`; the CLI at runtime resolves it through `dist/` — rebuild core (`npx tsc --build`) after changing it before running the CLI.

## Architecture

- **`packages/core`** — pure, dependency-free: token types and the weighted-token formula (`tokens.ts`), pricing with dated rate history (`pricing.ts`), model labels/makers/families/logos, allowed sources (`sources.ts`), per-user percentile levels and the SVG graph renderer (`levels.ts`, `graph.ts`, `graph-colors.ts`), graph days by family (`graph-days.ts`), the embed font (`embed-font.ts`, generated), the published SVG set (`published-graphs.ts`), story data (`story/`), the `Adapter` interface. No file or network I/O, no third-party imports. `.js` import suffixes (NodeNext).
- **`packages/cli`** — the `tokengraph` CLI (`view` default in a TTY, `login`, `logout`, `sync`, `readme`, `story`, `status`, `install-hook --agent <claude-code|cursor|codex>`, `schedule`). Adapters in `src/adapters/<agent>/` (see the per-agent notes below). `src/github/` talks to GitHub (HTTP client, device flow, auth via a stored token or the `gh` CLI). `src/publish/` builds machine files, finds or creates the two gists and publishes. `src/story/` renders cards with Satori + resvg-wasm (assets in `packages/cli/assets/`); `src/share/` is the QR hand-off server. `src/tui/` is the dependency-free terminal view. State lives in `~/.tokengraph/` (`$TOKENGRAPH_HOME`): `config.json` (machine id, GitHub login and auth, gist ids, graph colours; mode 0600), `state.json` ledger (v3, keyed by source and pricing tier), `machines.json` (other machines' files from the last publish, for offline use).
- Adapter sources: `claude-code` streams `~/.claude/projects/**/*.jsonl` (respects `CLAUDE_CONFIG_DIR`); `codex` streams `$CODEX_HOME/{sessions,archived_sessions}/**/*.jsonl`; `cursor` reads `~/.tokengraph/cursor-events.jsonl` written by `tokengraph cursor-hook`; `gemini-cli` streams `*/chats/**` under `${GEMINI_CLI_HOME:-~}/.gemini/tmp` and `~/.cache/.gemini/tmp`; `cline` reads classic `ui_messages.json` and SDK `*.messages.json`; `opencode` reads `opencode*.db` (`node:sqlite`) and the pre-1.2 `storage/` JSON tree.

### Invariants that are easy to break

- **Dedup by `message.id`** (Claude Code), **by `response_id` across files** (Codex), **by message `id` across files** (Gemini CLI), **classic `taskId + ts`, SDK message `id`** (Cline; skip the `claude-code` provider, imported sessions, legacy-copy metrics, `deleted_api_reqs`, `*.compaction.json`), **message id plus fork fingerprint** (OpenCode; step-finish parts are the request unit; pre-1.3.16 rule in `docs/agents/opencode-usage.md`). `<synthetic>` model is excluded. Never count usage another adapter already counts (Cline and OpenCode skip the `claude-code` provider).
- **Within one machine totals only grow** (ledger max-merge, also against the machine's own file in the data gist). **Across machines usage is summed.** Never sum a machine with itself; `logout` keeps the machine id.
- **Weighted tokens** = `input + output + cache_creation + 0.1 × cache_read`; sum per day first, then weight.
- **Cache-write 5m/1h split is `null` when unknown, never 0.** Unpriced models are unknown, never $0.
- **Pricing tier is a key dimension**; pricing changes append a new `effectiveFrom` entry, never edit a rate.
- **New adapter/source:** also add it to `KNOWN_SOURCES` in `packages/core/src/sources.ts`.
- **The view never publishes.** Only `sync` (manual, hook or schedule), `login` and `readme --colors` talk to GitHub. `status`, `view`, `story` are offline.
- **The public graph gist holds only SVGs and a README** — family colours and names, never model ids or per-model counts (only daily totals). Those live only in the secret data gist.
- **Codex `notify` is single-valued**; never overwrite one that is not ours.
- **The Claude Code hook must return instantly** (runs hidden `hook-sync`, which spawns a detached `sync`).
- **Hook, script and asset paths resolve through `bin-path.ts`** (`binPath()`, `assetsDir()`), never `import.meta.url` in a command: inside the bundle every module shares one URL.
- **Tests never touch the real `~/.tokengraph` or the real GitHub.** Network tests use `test/fake-github.ts`. Tests run with a throwaway `HOME` (and agent/XDG folders) from `packages/cli/test/setup-home.ts`, wherever vitest is started: the package `vitest.config.ts` files reuse the root config, and `configHome()` throws under vitest without `TOKENGRAPH_HOME`.
- **`canonicalModelId`** is the only place provider decorations are stripped. **Cursor model slugs are normalised** by `normalizeCursorModel`. The Cursor event file is never pruned.
- **Per-model colour = model family, never agent.** Hue is never the only channel.
- **Colour levels are per-user percentiles** (p25/p50/p75 of the user's own non-zero days).
- **The QR share server** binds to one private LAN address, serves only from memory under a random token, and always stops.
