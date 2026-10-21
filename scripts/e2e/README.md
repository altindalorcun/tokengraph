# End-to-end checks with real agents

`run.mjs` drives the real agents against `fake-llm.mjs` and compares what tokengraph counted with what the fake server
sent. `fake-llm.mjs` is described further down.

## run.mjs

```bash
npx tsc --build                                  # run.mjs builds it for you if dist/ is missing
node scripts/e2e/run.mjs                         # all agents
node scripts/e2e/run.mjs codex-cli pi --keep     # some agents; --keep leaves each throwaway HOME and the server log
node scripts/e2e/run.mjs cline --verbose         # keep every run's output in the result file
```

Flags: `--keep`, `--verbose`, `--timeout <seconds per agent run>` (default 180), `--out <file>` (default
`scripts/e2e/.cache/result.json`). Exit code 1 when any agent is FAIL or ERROR. It needs the network once, to install the
pinned agents (`npm install --prefix scripts/e2e/.cache/<agent>-<version>`; Goose is downloaded from its GitHub release);
the runs themselves only talk to `127.0.0.1`.

Per agent it installs the pinned version into `scripts/e2e/.cache` (gitignored); starts `fake-llm` on a random port with a
fresh log; makes a throwaway HOME (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_* and the agent's own data-dir variable
all inside it, a minimal environment, no real provider keys); writes the agent's provider config pointing at the fake
server; and, for every protocol the agent supports (chat, responses, anthropic, or the Gemini API), runs three scenarios:
a one-shot prompt, a second prompt resuming that session, and a prompt that goes through a tool loop (the server asks for
a read-only tool for two turns, set at run time through `POST /__control`). Then it runs `sync --local` and
`export --format json` of this checkout's build (`packages/cli/dist/bin.js`) with the same HOME and
`TOKENGRAPH_HOME=<HOME>/.tokengraph`, and compares, per model, input, output, cache read and cache write with the sum of
the server's normalized fields over every completion that carried usage. Each protocol has its own model name
(`fake-chat`, `fake-resp`, `fake-anth`, `fake-gemini`), so a row is one agent on one protocol.

**PASS means the counters match exactly, after the rules in `rules.mjs`.** A rule is a documented difference between what
an agent sends and what it records on disk; each one cites the sentence in `docs/agents/` that justifies it and is printed
next to the row it was applied to. Anything else is a FAIL. A scenario that exits non-zero or makes no request also fails
the agent (except one the driver marks as impossible, which is printed as skipped with the reason).

| Agent | Pinned | Protocols driven | Notes |
|---|---|---|---|
| Claude Code | 2.1.304 | anthropic | `CLAUDE_CONFIG_DIR`, `-p`, resume with `-c` |
| Codex CLI | 0.163.0 | responses | provider in `$CODEX_HOME/config.toml`; resume `exec resume --last` |
| Gemini CLI | 0.64.0 | Gemini API | needs `GEMINI_CLI_TRUST_WORKSPACE=true`; resume `--resume latest` |
| Cline | 3.0.73 | chat, responses, anthropic | the fake ends its loop with Cline's `submit_and_exit`; **no resume scenario** (`--id` with `--json` fails headlessly). Rule `cline-reasoning-subtracted` |
| OpenCode | 1.19.3 | chat, responses, anthropic | config in `OPENCODE_CONFIG_CONTENT`. Rule `opencode-title-requests` |
| Kilo | 7.8.15 | chat, responses, anthropic | config in `KILO_CONFIG_CONTENT` (not the OpenCode name) |
| Copilot CLI | 1.0.100 | chat, responses, anthropic | BYOK through `COPILOT_PROVIDER_*`, `COPILOT_OFFLINE=true` |
| pi | 0.73.1 | chat, responses, anthropic | `models.json` in `PI_CODING_AGENT_DIR` (the package is deprecated in favour of `@earendil-works/pi-coding-agent`) |
| Qwen Code | 0.25.3 | chat | usage statistics stay on, because the usage ledger (the only place the memory extractor's requests are written) exists only then |
| Goose | 1.55.0 | chat, responses (model `gpt-5.4`), anthropic | release binary per OS and architecture; `GOOSE_PATH_ROOT` on Windows only |
| Cursor | none | none | SKIP: the agent speaks a private, account-bound protocol, so no fake server can drive it; its adapter is checked from committed real samples |

The pinned versions are in `versions.json` (the CI cache key hashes that file; bump a version there).

## Platforms

macOS (arm64) and Linux (arm64, in Docker, see below) have been run for real. Windows has not been run locally; its code
paths are written from the agents' manifests and docs and get their first real run from the workflow below.

### Linux in Docker

Run the suite as a non-root user: Claude Code refuses `--dangerously-skip-permissions` as root. The official
`node:22-bookworm` image already has everything the agents need (git, ca-certificates, tar, a C toolchain for optional
native modules); no libsecret or keyring service is needed because Goose runs with `GOOSE_DISABLE_KEYRING=1` and the
other agents get their keys from the environment.

```bash
mkdir -p /tmp/tg-work /tmp/tg-out
cat > /tmp/tg-inner.sh <<'EOF'
#!/bin/bash
set -e
cd /work
tar -C /src --exclude=node_modules --exclude=dist --exclude=.cache --exclude=.git --exclude='*.tsbuildinfo' -cf - . | tar -xf -
npm ci --no-audit --no-fund
npx tsc --build
node scripts/e2e/run.mjs "$@" --out /out/result.json
EOF
chmod +x /tmp/tg-inner.sh
docker run --rm --user 1000:1000 -e HOME=/tmp/hh \
  -v "$PWD":/src:ro -v /tmp/tg-work:/work -v /tmp/tg-out:/out -v /tmp/tg-inner.sh:/inner.sh:ro \
  node:22-bookworm /inner.sh            # append agent names to run only those
```

The checkout is copied in (not mounted read-write) so the macOS `node_modules` and `dist` are never mixed with the Linux
ones. Keep `/tmp/tg-work` between runs to reuse the agent installs in `scripts/e2e/.cache`. On an arm64 host the image is
linux/arm64; all ten agents (including the Goose `aarch64-unknown-linux-gnu` release) ran and passed there with the same
request counts as on macOS. The x64 builds run on `ubuntu-latest`. The harness falls back to the `bin` entry of the
package manifest when npm 10 (bundled with Node 22) does not create the `node_modules/.bin` link, which happens for
`cline@3.0.73`.

### Windows

What `run.mjs` does for Windows (unverified until the workflow has run on `windows-latest`):

- npm agents are started through their `.cmd` shim in `node_modules/.bin`. Node refuses to spawn a `.cmd` without a shell,
  so the command line is built by hand with `cmd.exe` quoting; a timeout runs `taskkill /T /F` on the whole tree (POSIX:
  the child gets its own process group and the group is killed).
- The Goose release is a `.zip`; it is unpacked with `%SystemRoot%\System32\tar.exe` (bsdtar, reads zip) by full path,
  because Git for Windows puts a GNU tar first on PATH, and `Expand-Archive` is the fallback. `goose.exe` is searched
  for inside the unpacked folder.
- The throwaway home sets `HOME`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, the `XDG_*` folders
  and each agent's own variable (`CODEX_HOME`, `GEMINI_CLI_HOME`, `COPILOT_HOME`, `GOOSE_PATH_ROOT`, ...). Only
  `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP` and a few similar variables are passed through.
- Claude Code needs Git Bash for its shell tool: `CLAUDE_CODE_GIT_BASH_PATH` (default
  `C:\Program Files\Git\bin\bash.exe`, where GitHub's runners have it) is passed on when the file exists.
- Codex prints a warning that `CODEX_HOME` is under the temp folder ("Refusing to create helper binaries under temporary
  dir") on every OS and carries on; the run does not depend on it.

## Workflow

`.github/workflows/e2e.yml` runs the suite on `ubuntu-latest`, `macos-latest` and `windows-latest` (Node 22,
`fail-fast: false`, 45 minute job limit, `contents: read`, no secrets). Triggers: manual (`workflow_dispatch`, optional
`agents` input such as `codex-cli goose`) and weekly (Monday 05:17 UTC). The agent installs are cached with
`actions/cache` keyed on OS, architecture and a hash of `versions.json`. Each job uploads `scripts/e2e/.cache/result.json`
(`e2e-result-<os>`); when it fails it also uploads `scripts/e2e/.cache/logs` (the fake server's request log of every agent
that did not pass, `e2e-logs-<os>`). It is not part of `ci.yml`: it installs a dozen third-party CLIs.

---

# fake-llm

Dev-only fake LLM server for end-to-end agent checks. Point a real agent at it with a custom
base URL, run a session, then compare the tokens tokengraph counted with what the server
reported in its JSONL log. Not shipped in the npm package.

```bash
node scripts/e2e/fake-llm.mjs --port 0 --log /tmp/fake.jsonl --tool-turns 2
# prints: READY <port>
```

Protocols (streaming and non-streaming): Anthropic Messages (`/v1/messages`, `count_tokens`),
OpenAI Chat Completions, OpenAI Responses, Gemini `generateContent` / `streamGenerateContent`,
plus model lists. Any base-URL prefix is accepted. No auth is required. Unknown paths return a
logged 404.

| Flag | Meaning |
|---|---|
| `--port N` | Port on 127.0.0.1; `0` picks a random one (default) |
| `--log FILE` | JSONL log, truncated at start |
| `--models a,b,c` | Names returned by the model-list endpoints |
| `--tool-turns N` | First N turns of a conversation call a read-only tool (name matches `read\|list\|ls\|glob\|view`) when the request offers one |
| `--always-usage` | Send usage in chat streams even without `stream_options.include_usage` |
| `--exit-on-stdin-close` | Exit when stdin closes (handy when spawned by a script) |

## Usage numbers

Response number `n` (1, 2, ...) reports fresh input `1000+7n`, output `50+3n`, cache read
`200+11n`, and for Anthropic cache write `30+5n`, so no two responses share numbers. Reasoning
tokens are `5+n` (OpenAI and Gemini). Per protocol semantics: OpenAI `prompt_tokens` /
`input_tokens` include cached tokens and `completion_tokens` include reasoning; Anthropic
`input_tokens` excludes cache; Gemini `promptTokenCount` includes `cachedContentTokenCount`
and `candidatesTokenCount` excludes thoughts.

## Log lines

One line per request: `{ ts, status, protocol, endpoint, model, responseId, stream, usage,
normalized: { input, output, cacheRead, cacheWrite }, ... }`. `usage` is the object sent (for
Anthropic streams, `message_start` usage with the final `output_tokens`), or `null` when none
was sent (404s, model lists, `count_tokens`, chat streams without `include_usage`).
`normalized` is the exclusive view: `input` is fresh input only and `output` includes
reasoning. Gemini streams repeat identical cumulative `usageMetadata` on every chunk.

`POST /__control` with `{"toolTurns": N}` changes `--tool-turns` while the server runs. When a request offers a
completion tool (`submit_and_exit` or `attempt_completion`, Cline's way to end a loop) and no read-only turn is due, the
server calls it with schema-valid arguments instead of answering in plain text. Log lines also carry `toolNames` (the tools
the request offered) and `reasoning` (the reasoning tokens inside `normalized.output`; 0 for Anthropic).

Tests: `npx vitest run scripts/e2e`.

To run the workflow on a branch that is not on `main` yet, push it as `e2e/<name>`
(`git push origin HEAD:e2e/<name>`): a push to any `e2e/**` branch runs the full matrix.
