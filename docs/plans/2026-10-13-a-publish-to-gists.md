# Plan A: bootstrap, server removal, publishing to GitHub gists

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the imported hosted-era CLI into a server-free CLI whose `login` connects GitHub and whose `sync` publishes the README graph to the user's own gists, merging every machine through a secret data gist.

**Architecture:** `packages/core` gains the pure pieces (graph days by family, embed font, the four published SVGs). `packages/cli` loses every server module and gains `github/` (HTTP client, device flow, auth), `publish/` (machine files, gist discovery, the publish pipeline, an offline cache of other machines) and small helpers (clipboard, prompt, browser opener, README snippet). Commands `login`, `logout`, `sync`, `readme`, `status`, `view` are rewired on top.

**Tech Stack:** TypeScript (NodeNext, ESM), Node ≥ 22 built-ins only (`fetch`, `node:http` for the fake server in tests, `node:crypto`, `node:child_process`), Vitest, esbuild bundle.

**Spec:** `docs/specs/2026-10-13-local-first-design.md` (read it before starting any task).

## Global Constraints

- Workspace root for every command below: `/Users/orcunaltindal/codes/tokengraph/cli` unless stated.
- Node ≥ 22. No new runtime dependency in `packages/cli` or `packages/core`. `zod` is removed.
- `packages/core`: no file/network I/O, no third-party imports. `.js` suffixes on relative imports (NodeNext).
- Package names: CLI `tokengraph`, core `@tokengraph/core` (private, bundled).
- OAuth client id: `Ov23liunAdVeHoVD4vgm`; scope: `gist`. No client secret anywhere.
- API bases: `TOKENGRAPH_GITHUB_API` (default `https://api.github.com`), `TOKENGRAPH_GITHUB_WEB` (default `https://github.com`).
- Every GitHub API request sends `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: tokengraph/<version>`.
- Gist file names: graph gist `README.md`, `tokengraph-dark.svg`, `tokengraph-light.svg`, `tokengraph-compact-dark.svg`, `tokengraph-compact-light.svg`; data gist `tokengraph-data.md`, `machine-<uuid>.json`.
- Project URL used in copy: `https://github.com/altindalorcun/tokengraph`.
- Raw URL form: `https://gist.githubusercontent.com/<login>/<gistId>/raw/<file>` (no revision segment).
- `config.json` and every file holding a token: mode 0600, folder 0700.
- Tests never touch the real `~/.tokengraph` (`packages/cli/test/setup-home.ts` stays in `vitest.config.ts`) and never hit the real GitHub.
- Within one machine totals only grow (max-merge); across machines usage is summed. Never sum a machine with itself.
- The public graph gist never contains model ids or raw counts.
- Commit after every task: a subject line in the imperative mood, a short body when useful, and
  the last line exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A user whose `gh` is logged in without the `gist` scope runs `login`: they must fall through to the device flow, not get a token that fails on the first gist write (Task 12 test).
- The user deletes the graph gist by hand: the next `sync` recreates it and prints a loud notice with the new snippet; it must not crash or loop (Task 9 test).
- Two machines publish at nearly the same moment: each PATCHes only its own `machine-<id>.json`, so neither overwrites the other (Task 9 test asserts only own file in the PATCH body).
- A hosted-era `config.json` (`apiUrl`, `apiKey`, `deviceId`, `uploads`) is read: no crash, `deviceId` becomes `machineId`, the old keys disappear on the next write (Task 2 test).
- GitHub returns 403 with `x-ratelimit-remaining: 0` during a background sync: the ledger is still saved, the run exits 1 with a retry time, and nothing is half-written (Task 4 + Task 10 tests).

---

### Task 1: Import the hosted-final CLI into the new repo

**Files:**
- Create: everything under `packages/`, root `package.json`, `tsconfig*.json`, `vitest.config.ts`, `.gitignore`, `LICENSE` (from the archive)
- Create: `CLAUDE.md`
- Modify: `package.json`, `packages/cli/package.json`, `packages/core/package.json`, `vitest.config.ts`

**Interfaces:**
- Produces: a green build (`npx tsc --build`) and test run (`npx vitest run`) with the core package renamed to `@tokengraph/core`.

- [ ] **Step 1: Extract the archive (the repo already has `docs/` committed; keep it)**

```bash
cd /Users/orcunaltindal/codes/tokengraph/cli
git -C /Users/orcunaltindal/codes/tokengraph-cli archive hosted-final | tar -x -C .
rm -f package-lock.json
git status --short | head
```

- [ ] **Step 2: Rename the core package everywhere**

```bash
grep -rl "@token-graph/core" --exclude-dir=node_modules --exclude-dir=.git . | xargs sed -i '' 's#@token-graph/core#@tokengraph/core#g'
grep -rn "@token-graph/core" --exclude-dir=node_modules --exclude-dir=.git . ; echo "remaining: $?"
```
Expected: `remaining: 1` (no matches).

- [ ] **Step 3: Fix package metadata**

Root `package.json`: set `"name": "tokengraph-workspace"`. Add script `"bundle": "npm run build -w tokengraph"`.

`packages/cli/package.json`: `repository.url` → `git+https://github.com/altindalorcun/tokengraph.git`, `homepage` → `https://github.com/altindalorcun/tokengraph#readme`, `bugs.url` → `https://github.com/altindalorcun/tokengraph/issues`. Keep `version` `0.1.0`.

`packages/core/package.json`: name is now `@tokengraph/core` (from step 2).

- [ ] **Step 4: Install, build, test**

```bash
npm install
npx tsc --build
npx vitest run
```
Expected: build succeeds; all tests pass (the same suite as `tokengraph-cli@hosted-final`).

- [ ] **Step 5: Write `CLAUDE.md`**

Create `CLAUDE.md` with exactly this content:

````markdown
# CLAUDE.md

tokengraph is a GitHub-contribution-style heatmap of daily AI coding agent token usage (Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode). It is **local-first and has no server**: the CLI reads each agent's local logs, keeps a ledger on the machine, and publishes the README graph as SVG files to the user's own public GitHub gist; a secret gist holds every machine's ledger so machines merge and history survives a reinstall. Story cards (Instagram/TikTok PNGs) are rendered on the machine and handed to the phone with a QR code over the local network.

`docs/product.md` holds the vision and non-goals; `docs/specs/` and `docs/plans/` hold designs and plans. The private promo site lives in a separate repo and never imports this code.

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

- **Dedup by `message.id`** (Claude Code), **by `response_id` across files** (Codex), **by message `id` across files** (Gemini CLI), **classic `taskId + ts`, SDK message `id`** (Cline; skip the `claude-code` provider, imported sessions, legacy-copy metrics, `deleted_api_reqs`, `*.compaction.json`), **message id plus fork fingerprint** (OpenCode; step-finish parts are the request unit; pre-1.3.16 rule in `docs/opencode-usage.md`). `<synthetic>` model is excluded. Never count usage another adapter already counts (Cline and OpenCode skip the `claude-code` provider).
- **Within one machine totals only grow** (ledger max-merge, also against the machine's own file in the data gist). **Across machines usage is summed.** Never sum a machine with itself; `logout` keeps the machine id.
- **Weighted tokens** = `input + output + cache_creation + 0.1 × cache_read`; sum per day first, then weight.
- **Cache-write 5m/1h split is `null` when unknown, never 0.** Unpriced models are unknown, never $0.
- **Pricing tier is a key dimension**; pricing changes append a new `effectiveFrom` entry, never edit a rate.
- **New adapter/source:** also add it to `KNOWN_SOURCES` in `packages/core/src/sources.ts`.
- **The view never publishes.** Only `sync` (manual, hook or schedule), `login` and `readme --colors` talk to GitHub. `status`, `view`, `story` are offline.
- **The public graph gist holds only SVGs and a README** — family colours and names, never model ids or raw counts. Those live only in the secret data gist.
- **Codex `notify` is single-valued**; never overwrite one that is not ours.
- **The Claude Code hook must return instantly** (runs hidden `hook-sync`, which spawns a detached `sync`).
- **Hook, script and asset paths resolve through `bin-path.ts`** (`binPath()`, `assetsDir()`), never `import.meta.url` in a command: inside the bundle every module shares one URL.
- **Tests never touch the real `~/.tokengraph` or the real GitHub.** Network tests use `test/fake-github.ts`.
- **`canonicalModelId`** is the only place provider decorations are stripped. **Cursor model slugs are normalised** by `normalizeCursorModel`. The Cursor event file is never pruned.
- **Per-model colour = model family, never agent.** Hue is never the only channel.
- **Colour levels are per-user percentiles** (p25/p50/p75 of the user's own non-zero days).
- **The QR share server** binds to one private LAN address, serves only from memory under a random token, and always stops.
````

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Import the CLI and core from tokengraph-cli@hosted-final

Renames the core package to @tokengraph/core and points the package at
the new repository.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Remove the server and the hosted-era config

**Files:**
- Delete: `packages/cli/src/api.ts`, `packages/cli/src/payload.ts`, `packages/cli/src/upload-mode.ts`, `packages/cli/src/upload-record.ts`, `packages/cli/src/commands/uploads.ts`, `packages/cli/src/commands/login.ts`, `packages/core/src/schemas.ts`
- Delete tests: `packages/cli/test/{api,payload,upload-mode,upload-record,uploads,login}.test.ts`, `packages/core/test/schemas.test.ts`
- Rewrite: `packages/cli/src/config.ts`, `packages/cli/test/config.test.ts`
- Modify: `packages/cli/src/commands/{sync,status,view,logout}.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/paths.ts`, `packages/core/src/index.ts`, `packages/core/package.json`, `packages/cli/package.json`, `packages/cli/src/adapters/model-ids.ts` (comment only), tests that import removed modules (`sync.test.ts`, `status`-related, `tui/*` if they use `uploadMode`)
- Create: `packages/cli/src/hosted-leftovers.ts`, `packages/cli/test/hosted-leftovers.test.ts`

**Interfaces:**
- Produces (`config.ts`):

```ts
export type GitHubAuth = { kind: 'token'; token: string } | { kind: 'gh'; ghPath: string };
export interface GitHubAccount { login: string; auth: GitHubAuth }
export type GraphColors = 'model' | 'single';
export interface CliConfig {
  machineId?: string;
  github?: GitHubAccount;
  gists?: { graph?: string; data?: string };
  graph?: { colors?: GraphColors };
}
export function parseConfig(raw: unknown): CliConfig;
export function readConfig(path?: string): Promise<CliConfig>;
export function writeConfig(config: CliConfig, path?: string): Promise<void>;
```
- Produces (`hosted-leftovers.ts`): `export function removeHostedLeftovers(home?: string): Promise<void>` — deletes `uploaded.json` in the config home if present, never throws.
- `runSync` keeps its signature minus upload behaviour: `SyncOptions = { sinceDays: number; local?: boolean; svgPath?: string; theme: Theme; trigger?: SyncTrigger }`. After this task `sync` only collects and saves; publishing arrives in Task 10.

- [ ] **Step 1: Write the failing config tests** — replace `packages/cli/test/config.test.ts` with:

```ts
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, readConfig, writeConfig } from '../src/config.js';

const ID = '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40';

describe('parseConfig', () => {
  it('reads the local-first fields', () => {
    expect(
      parseConfig({
        machineId: ID,
        github: { login: 'octocat', auth: { kind: 'token', token: 'gho_abc' } },
        gists: { graph: 'aa11bb22cc33dd44ee55', data: '0123456789abcdef0123456789abcdef' },
        graph: { colors: 'single' },
      }),
    ).toEqual({
      machineId: ID,
      github: { login: 'octocat', auth: { kind: 'token', token: 'gho_abc' } },
      gists: { graph: 'aa11bb22cc33dd44ee55', data: '0123456789abcdef0123456789abcdef' },
      graph: { colors: 'single' },
    });
  });

  it('keeps a gh-backed account', () => {
    expect(parseConfig({ github: { login: 'octocat', auth: { kind: 'gh', ghPath: '/opt/homebrew/bin/gh' } } }).github).toEqual({
      login: 'octocat',
      auth: { kind: 'gh', ghPath: '/opt/homebrew/bin/gh' },
    });
  });

  it('turns a hosted-era deviceId into the machine id and drops the server fields', () => {
    expect(parseConfig({ apiUrl: 'http://localhost:3000', apiKey: 'tg_x', deviceId: ID, username: 'o', uploads: false })).toEqual({ machineId: ID });
  });

  it('prefers machineId over a legacy deviceId', () => {
    const other = '11111111-2222-4333-8444-555555555555';
    expect(parseConfig({ machineId: ID, deviceId: other }).machineId).toBe(ID);
  });

  it('drops malformed values instead of failing', () => {
    expect(
      parseConfig({
        machineId: 'nope',
        github: { login: 'bad login!', auth: { kind: 'token', token: 'x' } },
        gists: { graph: 'not hex', data: 42 },
        graph: { colors: 'rainbow' },
      }),
    ).toEqual({});
    expect(parseConfig({ github: { login: 'octocat', auth: { kind: 'token', token: '' } } })).toEqual({});
    expect(parseConfig(null)).toEqual({});
  });
});

describe('writeConfig', () => {
  it('writes an owner-only file that reads back the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tg-config-'));
    const path = join(dir, 'nested', 'config.json');
    const config = { machineId: ID, github: { login: 'octocat', auth: { kind: 'token' as const, token: 'gho_abc' } } };
    await writeConfig(config, path);
    expect(await readConfig(path)).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/cli/test/config.test.ts`
Expected: FAIL (old `parseConfig` returns `deviceId`/`apiKey` fields).

- [ ] **Step 3: Rewrite `packages/cli/src/config.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configPath } from './paths.js';

export type GitHubAuth = { kind: 'token'; token: string } | { kind: 'gh'; ghPath: string };

export interface GitHubAccount {
  login: string;
  auth: GitHubAuth;
}

export type GraphColors = 'model' | 'single';

export interface CliConfig {
  /** This machine's id in the data gist. Kept on logout: a machine must never come back under a new id. */
  machineId?: string;
  github?: GitHubAccount;
  /** Cached gist ids; found again by marker file when missing or deleted. */
  gists?: { graph?: string; data?: string };
  graph?: { colors?: GraphColors };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIST_ID = /^[0-9a-f]{20,40}$/i;
// GitHub logins: alphanumerics and single hyphens, no leading or trailing hyphen, at most 39 chars.
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseAuth(raw: unknown): GitHubAuth | undefined {
  const fields = record(raw);
  if (!fields) return undefined;
  if (fields['kind'] === 'token') {
    const token = text(fields['token']);
    return token ? { kind: 'token', token } : undefined;
  }
  if (fields['kind'] === 'gh') {
    const ghPath = text(fields['ghPath']);
    return ghPath ? { kind: 'gh', ghPath } : undefined;
  }
  return undefined;
}

/**
 * Keeps only well-formed fields, so a hand-edited or damaged file degrades to "logged out". Fields
 * from the hosted era (apiUrl, apiKey, username, uploads) are dropped; its deviceId becomes the
 * machine id, so the machine keeps its identity.
 */
export function parseConfig(raw: unknown): CliConfig {
  const fields = record(raw);
  if (!fields) return {};
  const config: CliConfig = {};

  const machineId = [text(fields['machineId']), text(fields['deviceId'])].find((id) => id !== undefined && UUID.test(id));
  if (machineId) config.machineId = machineId.toLowerCase();

  const github = record(fields['github']);
  if (github) {
    const login = text(github['login']);
    const auth = parseAuth(github['auth']);
    if (login && LOGIN.test(login) && auth) config.github = { login, auth };
  }

  const gists = record(fields['gists']);
  if (gists) {
    const graph = text(gists['graph']);
    const data = text(gists['data']);
    const parsed: NonNullable<CliConfig['gists']> = {};
    if (graph && GIST_ID.test(graph)) parsed.graph = graph;
    if (data && GIST_ID.test(data)) parsed.data = data;
    if (parsed.graph || parsed.data) config.gists = parsed;
  }

  const graph = record(fields['graph']);
  const colors = graph?.['colors'];
  if (colors === 'model' || colors === 'single') config.graph = { colors };

  return config;
}

export async function readConfig(path = configPath()): Promise<CliConfig> {
  try {
    return parseConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return {};
  }
}

export async function writeConfig(config: CliConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  // The file can hold a GitHub token, so only its owner may read it.
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
```

- [ ] **Step 4: Run the config tests**

Run: `npx vitest run packages/cli/test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing leftovers test** — `packages/cli/test/hosted-leftovers.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeHostedLeftovers } from '../src/hosted-leftovers.js';

describe('removeHostedLeftovers', () => {
  it('deletes the upload record and leaves the ledger alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tg-leftovers-'));
    await writeFile(join(home, 'uploaded.json'), '{}');
    await writeFile(join(home, 'state.json'), '{}');
    await removeHostedLeftovers(home);
    expect(existsSync(join(home, 'uploaded.json'))).toBe(false);
    expect(existsSync(join(home, 'state.json'))).toBe(true);
  });

  it('does nothing when there is nothing to remove', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tg-leftovers-'));
    await expect(removeHostedLeftovers(home)).resolves.toBeUndefined();
    await expect(removeHostedLeftovers(join(home, 'missing'))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Implement `packages/cli/src/hosted-leftovers.ts`**

```ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome } from './paths.js';

/** Files only the hosted version wrote. Removing them is tidy-up, so it never fails a command. */
const HOSTED_FILES = ['uploaded.json'] as const;

export async function removeHostedLeftovers(home: string = configHome()): Promise<void> {
  await Promise.all(HOSTED_FILES.map((file) => rm(join(home, file), { force: true }).catch(() => undefined)));
}
```

- [ ] **Step 7: Delete the server modules and their tests**

```bash
git rm -q packages/cli/src/api.ts packages/cli/src/payload.ts packages/cli/src/upload-mode.ts packages/cli/src/upload-record.ts \
  packages/cli/src/commands/uploads.ts packages/cli/src/commands/login.ts packages/core/src/schemas.ts \
  packages/cli/test/api.test.ts packages/cli/test/payload.test.ts packages/cli/test/upload-mode.test.ts \
  packages/cli/test/upload-record.test.ts packages/cli/test/uploads.test.ts packages/cli/test/login.test.ts \
  packages/core/test/schemas.test.ts
```

Then:
- `packages/core/src/index.ts`: remove `export * from './schemas.js';`.
- `packages/core/package.json`: remove the `dependencies` block (zod).
- `packages/cli/package.json`: remove `dependencies` (zod) and `--external:zod` from the `build` script.
- `packages/cli/src/adapters/model-ids.ts` line 1 comment: replace with `/** Longest model id kept; longer ids are cut so a damaged record cannot bloat the ledger. */` (keep the constant it documents).
- `packages/cli/src/paths.ts`: delete `uploadRecordPath()`; add:

```ts
/** Other machines' files from the data gist, as of the last publish (`publish/machines-cache.ts`). */
export function machinesCachePath(): string {
  return join(configHome(), 'machines.json');
}
```

- [ ] **Step 8: Strip uploading from `sync.ts`**

In `packages/cli/src/commands/sync.ts` delete the imports of `api.js`, `config.js`, `payload.js`, `upload-mode.js`, `upload-record.js` and `uploadRecordPath`, and replace everything after the `--svg` block (from `if (options.local) {` to the end of `runSyncLocked`) with:

```ts
  if (!options.local) {
    console.log('\nSaved locally. Run `tokengraph login` to put this graph in your GitHub README.');
  }
  return 0;
}
```

- [ ] **Step 9: Rewire `status.ts`, `view.ts`, `logout.ts`, `bin.ts`**

`packages/cli/src/commands/view.ts`: replace the status-line function body (the `switch (uploadMode(config))`) with:

```ts
  const config = await readConfig();
  return config.github ? `↑ publishing as @${config.github.login}` : 'local only';
```
and remove the `upload-mode.js` import.

`packages/cli/src/commands/status.ts`: remove `statusUploads`, the `upload-mode` import and `resolveApiUrl`; replace the four account/server/device/uploads lines with:

```ts
  console.log(`version: ${cliVersion()}`);
  console.log(`github:  ${config.github ? `@${config.github.login} (${config.github.auth.kind === 'gh' ? 'via gh' : 'tokengraph login'})` : 'not logged in'}`);
  console.log(`machine: ${config.machineId ?? 'not set yet (set on first publish)'}`);
```
(Task 11 extends this.)

`packages/cli/src/commands/logout.ts`: replace with a placeholder that compiles and is replaced in Task 12:

```ts
import { readConfig, writeConfig } from '../config.js';

export async function runLogout(): Promise<number> {
  const config = await readConfig();
  if (!config.github) {
    console.log('Not logged in.');
    return 0;
  }
  const { github: _github, gists: _gists, ...rest } = config;
  await writeConfig(rest);
  console.log('Logged out.');
  return 0;
}
```

`packages/cli/src/bin.ts`: remove the `login` and `uploads` entries and their imports; remove `--api-url`/`--new-device`; remove the `uploads` and `login` lines from `USAGE`; replace the last USAGE line with `Everything works without logging in: usage stays on this machine until you publish it.`. Call `await removeHostedLeftovers()` right after `migrateLegacyHome()` (import from `./hosted-leftovers.js`).

- [ ] **Step 10: Fix the remaining compile and test errors**

Run: `npx tsc --build 2>&1 | head -40` and fix every error by deleting test cases that exercise uploading (`sync.test.ts` upload cases, `status` expectations about `server:`/`uploads:`, `tui` tests that mock `uploadMode`). Do not delete adapter, ledger or TUI rendering tests. Then:

Run: `npx tsc --build && npx vitest run`
Expected: all green. `grep -rn "apiKey\|uploadMode\|DEFAULT_API_URL\|zod" packages --include=*.ts` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Remove the hosted server: uploads, device pairing and zod

Config keeps the machine id (a hosted-era deviceId becomes it) and
gains the GitHub account, gist ids and graph colours.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Core — graph days by family, embed font, the published SVG set

**Files:**
- Create: `packages/core/src/graph-days.ts`, `packages/core/src/embed-font.ts` (copied, generated), `packages/core/src/published-graphs.ts`, `scripts/build-embed-font.mjs` (copied)
- Create tests: `packages/core/test/graph-days.test.ts`, `packages/core/test/published-graphs.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/commands/sync.ts` (the `--svg` preview uses the new function)

**Interfaces:**
- Consumes: `renderGraphSvg`, `ColorMode`, `Theme`, `weightedTokens`, `modelFamily`, `MODEL_FAMILIES`, `CACHE_READ_WEIGHT`, `addDays`, `dateKey`, `DailyModelUsage` from core.
- Produces:

```ts
// graph-days.ts
export const GRAPH_WINDOW_DAYS = 372;
export interface ModelDayRow { date: string; model: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
export interface FamilyGraphDay extends GraphDay { topFamily: ModelFamily | null }
export function usageToModelRows(usage: readonly DailyModelUsage[]): ModelDayRow[];
export function toGraphDaysByFamily(rows: readonly ModelDayRow[]): FamilyGraphDay[];
export function graphEndDate(today: string, dates: readonly string[]): string;
// published-graphs.ts
export const PUBLISHED_GRAPH_FILES: readonly ['tokengraph-dark.svg', 'tokengraph-light.svg', 'tokengraph-compact-dark.svg', 'tokengraph-compact-light.svg'];
export type PublishedGraphFile = (typeof PUBLISHED_GRAPH_FILES)[number];
export type GraphColorsSetting = 'model' | 'single';
export function renderPublishedGraphs(usage: readonly DailyModelUsage[], options: { today: string; colors: GraphColorsSetting }): Record<PublishedGraphFile, string>;
// embed-font.ts
export const EMBED_FONT_FACE_CSS: string;
```

- [ ] **Step 1: Copy the sources from the hosted repo**

```bash
SRC=/Users/orcunaltindal/codes/token-graph
cp $SRC/apps/web/lib/embed-font.ts packages/core/src/embed-font.ts
mkdir -p scripts && cp $SRC/scripts/build-embed-font.mjs scripts/build-embed-font.mjs
cp $SRC/apps/web/test/graph-days-by-family.test.ts packages/core/test/graph-days.test.ts
sed -n 1,200p $SRC/apps/web/lib/graph-days.ts
```
Edit `scripts/build-embed-font.mjs` so its output path is `packages/core/src/embed-font.ts` and any input font path still resolves (point it at a fonts folder argument if it referenced `apps/web/public`; if it needs a font that is not in this repo, make the script take the font directory as `process.argv[2]` and document that at its top). The generated file header must keep the OFL notice.

- [ ] **Step 2: Write `packages/core/src/graph-days.ts`**

Port `toGraphDaysByFamily`, `FamilyGraphDay`, `graphEndDate`, `GRAPH_WINDOW_DAYS` verbatim from `apps/web/lib/graph-days.ts` (shown in Step 1 output) with relative imports (`./tokens.js`, `./model-makers.js`, `./graph.js`), define `ModelDayRow` as in Interfaces (it replaces `apps/web/lib/graph-models.ts`'s type), and add:

```ts
/** Ledger usage (any number of sources and machines) as per-model day rows; tiers and the cache split fold away. */
export function usageToModelRows(usage: readonly DailyModelUsage[]): ModelDayRow[] {
  return usage.map((entry) => ({
    date: entry.date,
    model: entry.model,
    inputTokens: entry.counts.inputTokens,
    outputTokens: entry.counts.outputTokens,
    cacheCreationTokens: entry.counts.cacheCreationTokens,
    cacheReadTokens: entry.counts.cacheReadTokens,
  }));
}
```
Do not port `normalizeUsername` or `toGraphDays` (unused). Fix the copied test's imports to `../src/graph-days.js` and drop cases for removed functions. Add this test to it:

```ts
it('sums rows of the same day and model from different machines', () => {
  const counts = { inputTokens: 100, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const days = toGraphDaysByFamily([
    { date: '2026-10-01', model: 'claude-opus-5-5', ...counts },
    { date: '2026-10-01', model: 'claude-opus-5-5', ...counts },
  ]);
  expect(days).toEqual([{ date: '2026-10-01', weighted: 200, topFamily: 'claude' }]);
});
```
(Use the family key the core actually exports for Claude; check `MODEL_FAMILIES` in `model-makers.ts`.)

- [ ] **Step 3: Write the failing published-graphs test** — `packages/core/test/published-graphs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PUBLISHED_GRAPH_FILES, renderPublishedGraphs } from '../src/published-graphs.js';
import type { DailyModelUsage } from '../src/types.js';

const counts = { inputTokens: 1_000_000, outputTokens: 20_000, cacheCreationTokens: 0, cacheReadTokens: 5_000_000, cacheCreation5mTokens: null, cacheCreation1hTokens: null };
const usage: DailyModelUsage[] = [
  { date: '2026-10-10', model: 'claude-opus-5-5', pricingTier: 'standard', counts },
  { date: '2026-10-11', model: 'gpt-5.5', pricingTier: 'standard', counts },
];

describe('renderPublishedGraphs', () => {
  it('renders the four files', () => {
    const files = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    expect(Object.keys(files).sort()).toEqual([...PUBLISHED_GRAPH_FILES].sort());
    for (const svg of Object.values(files)) expect(svg.startsWith('<svg')).toBe(true);
  });

  it('is deterministic', () => {
    const a = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    const b = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    expect(a).toEqual(b);
  });

  it('never exposes model ids', () => {
    const files = renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'model' });
    for (const svg of Object.values(files)) {
      expect(svg).not.toContain('claude-opus-5-5');
      expect(svg).not.toContain('gpt-5.5');
    }
  });

  it('embeds the font so the SVG renders inside an <img>', () => {
    expect(renderPublishedGraphs(usage, { today: '2026-10-13', colors: 'single' })['tokengraph-light.svg']).toContain('@font-face');
  });

  it('draws an empty graph with a title instead of failing', () => {
    expect(renderPublishedGraphs([], { today: '2026-10-13', colors: 'model' })['tokengraph-dark.svg']).toContain('No tokens synced yet');
  });
});
```

Run: `npx vitest run packages/core/test/published-graphs.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `packages/core/src/published-graphs.ts`**

```ts
import { addDays, dateKey } from './dates.js';
import { EMBED_FONT_FACE_CSS } from './embed-font.js';
import { renderGraphSvg, type ColorMode, type Theme } from './graph.js';
import { GRAPH_WINDOW_DAYS, graphEndDate, toGraphDaysByFamily, usageToModelRows } from './graph-days.js';
import type { DailyModelUsage } from './types.js';

export const PUBLISHED_GRAPH_FILES = [
  'tokengraph-dark.svg',
  'tokengraph-light.svg',
  'tokengraph-compact-dark.svg',
  'tokengraph-compact-light.svg',
] as const;
export type PublishedGraphFile = (typeof PUBLISHED_GRAPH_FILES)[number];
export type GraphColorsSetting = 'model' | 'single';

const VARIANTS: Record<PublishedGraphFile, { theme: Theme; compact: boolean }> = {
  'tokengraph-dark.svg': { theme: 'dark', compact: false },
  'tokengraph-light.svg': { theme: 'light', compact: false },
  'tokengraph-compact-dark.svg': { theme: 'dark', compact: true },
  'tokengraph-compact-light.svg': { theme: 'light', compact: true },
};

/**
 * The README graph as published to the graph gist: the year ending today, summed over every
 * machine's usage. Deterministic for the same input and day, so an unchanged graph is never
 * re-uploaded. Only family colours and names reach the SVG, never model ids.
 */
export function renderPublishedGraphs(
  usage: readonly DailyModelUsage[],
  options: { today: string; colors: GraphColorsSetting },
): Record<PublishedGraphFile, string> {
  const since = dateKey(addDays(new Date(`${options.today}T12:00:00Z`), -GRAPH_WINDOW_DAYS), 'UTC');
  const days = toGraphDaysByFamily(usageToModelRows(usage.filter((entry) => entry.date >= since)));
  const endDate = graphEndDate(options.today, days.map((day) => day.date));
  const colorMode: ColorMode = options.colors === 'single' ? 'single' : 'per-model';
  const files = {} as Record<PublishedGraphFile, string>;
  for (const file of PUBLISHED_GRAPH_FILES) {
    const { theme, compact } = VARIANTS[file];
    files[file] = renderGraphSvg(days, {
      endDate,
      theme,
      compact,
      colorMode,
      fontFaceCss: EMBED_FONT_FACE_CSS,
      title: days.length === 0 ? 'No tokens synced yet' : undefined,
    });
  }
  return files;
}
```
If `dateKey`'s signature in `packages/core/src/dates.ts` differs (check it), adapt the call; if `ColorMode` has other member names, map `'model'` to the per-family member.

Add to `packages/core/src/index.ts`: `export * from './embed-font.js';`, `export * from './graph-days.js';`, `export * from './published-graphs.js';`.

- [ ] **Step 5: Run core tests**

Run: `npx vitest run packages/core`
Expected: PASS. If the "never exposes model ids" test fails, the renderer prints model ids somewhere (e.g. a `<title>`): fix the renderer call (do not pass per-day model details) rather than the test.

- [ ] **Step 6: Use it for `sync --svg`**

In `sync.ts`, replace the `--svg` block's `renderGraphSvg(days, …)` with:

```ts
    const files = renderPublishedGraphs(allLedgerUsage(ledger), { today: dateKey(new Date()), colors: 'model' });
    await writeFile(options.svgPath, files[options.theme === 'dark' ? 'tokengraph-dark.svg' : 'tokengraph-light.svg'], 'utf8');
```

Run: `npx tsc --build && npx vitest run` → green.

- [ ] **Step 7: Commit** (`Move graph days, the embed font and the published SVG set into core`).

---

### Task 4: GitHub HTTP client

**Files:**
- Create: `packages/cli/src/github/http.ts`, `packages/cli/test/github-http.test.ts`

**Interfaces:**
- Consumes: `cliVersion()` from `bin-path.ts`.
- Produces:

```ts
export function githubApiBase(env?: NodeJS.ProcessEnv): string;
export function githubWebBase(env?: NodeJS.ProcessEnv): string;
export class GitHubError extends Error { readonly status: number }
export class GitHubAuthError extends GitHubError {}
export class GitHubNotFoundError extends GitHubError {}
export class GitHubRateLimitError extends GitHubError { readonly resetAt: Date | null }
export interface GistFile { filename: string; content?: string; truncated?: boolean; raw_url?: string }
export interface Gist { id: string; description: string | null; public: boolean; html_url: string; files: Record<string, GistFile | null> }
export interface GitHubUser { login: string; scopes: string[] | null }
export interface GitHubClient {
  getUser(): Promise<GitHubUser>;
  listGists(): Promise<Gist[]>;
  getGist(id: string): Promise<Gist>;
  createGist(input: { description: string; public: boolean; files: Record<string, string> }): Promise<Gist>;
  updateGist(id: string, files: Record<string, string | null>): Promise<Gist>;
}
export interface GitHubClientOptions { token: () => Promise<string>; apiBase?: string; fetch?: typeof fetch; userAgent?: string }
export function createGitHubClient(options: GitHubClientOptions): GitHubClient;
```

- [ ] **Step 1: Write the failing tests** — `packages/cli/test/github-http.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createGitHubClient,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  githubApiBase,
} from '../src/github/http.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responses(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init });

const client = (fetch: typeof globalThis.fetch) =>
  createGitHubClient({ token: async () => 'gho_test', apiBase: 'https://api.test', fetch, userAgent: 'tokengraph/test' });

describe('githubApiBase', () => {
  it('defaults to api.github.com and honours the override', () => {
    expect(githubApiBase({})).toBe('https://api.github.com');
    expect(githubApiBase({ TOKENGRAPH_GITHUB_API: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
  });
});

describe('GitHub client', () => {
  it('sends the auth and API headers', async () => {
    const { fetch, calls } = fakeFetch(() => json({ login: 'octocat' }, { headers: { 'x-oauth-scopes': 'gist, read:org' } }));
    expect(await client(fetch).getUser()).toEqual({ login: 'octocat', scopes: ['gist', 'read:org'] });
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe('https://api.test/user');
    expect(headers.get('authorization')).toBe('Bearer gho_test');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toBe('tokengraph/test');
  });

  it('reports unknown scopes as null (fine-grained tokens send no header)', async () => {
    const { fetch } = fakeFetch(() => json({ login: 'octocat' }));
    expect((await client(fetch).getUser()).scopes).toBeNull();
  });

  it('pages through every gist', async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `g${n}-${i}`, description: null, public: true, html_url: '', files: {} }));
    const { fetch, calls } = fakeFetch((call) => json(call.url.includes('page=1') ? page(1, 100) : page(2, 3)));
    expect(await client(fetch).listGists()).toHaveLength(103);
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/gists?per_page=100&page=1', 'https://api.test/gists?per_page=100&page=2']);
  });

  it('fills a truncated file from its raw URL without sending the token there', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.startsWith('https://raw.test')
        ? new Response('full content')
        : json({ id: 'abc', description: null, public: false, html_url: '', files: { 'a.json': { filename: 'a.json', content: 'cut', truncated: true, raw_url: 'https://raw.test/a.json' } } }),
    );
    const gist = await client(fetch).getGist('abc');
    expect(gist.files['a.json']!.content).toBe('full content');
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBeNull();
  });

  it('creates and updates gists with JSON bodies', async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: 'new', description: 'd', public: true, html_url: 'h', files: {} }));
    await client(fetch).createGist({ description: 'd', public: true, files: { 'a.svg': '<svg/>' } });
    await client(fetch).updateGist('new', { 'a.svg': '<svg></svg>', 'old.svg': null });
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ description: 'd', public: true, files: { 'a.svg': { content: '<svg/>' } } });
    expect(calls[1]!.url).toBe('https://api.test/gists/new');
    expect(calls[1]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ files: { 'a.svg': { content: '<svg></svg>' }, 'old.svg': null } });
  });

  it('maps 401, 404 and rate limits to typed errors', async () => {
    await expect(client(fakeFetch(() => json({ message: 'Bad credentials' }, { status: 401 })).fetch).getUser()).rejects.toBeInstanceOf(GitHubAuthError);
    await expect(client(fakeFetch(() => json({ message: 'Not Found' }, { status: 404 })).fetch).getGist('x')).rejects.toBeInstanceOf(GitHubNotFoundError);
    const limited = fakeFetch(() => json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } }));
    const error = await client(limited.fetch).getUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt?.getTime()).toBe(1_800_000_000_000);
    const secondary = fakeFetch(() => json({ message: 'secondary rate limit' }, { status: 429, headers: { 'retry-after': '60' } }));
    expect(await client(secondary.fetch).getUser().catch((e: unknown) => e)).toBeInstanceOf(GitHubRateLimitError);
  });

  it('wraps network failures in GitHubError with status 0', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const error = await client(fetch).getUser().catch((e: unknown) => e);
    expect((error as { status: number }).status).toBe(0);
  });
});
```

Run: `npx vitest run packages/cli/test/github-http.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `packages/cli/src/github/http.ts`**

```ts
import { cliVersion } from '../bin-path.js';

export function githubApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['TOKENGRAPH_GITHUB_API'] ?? 'https://api.github.com').replace(/\/+$/, '');
}

export function githubWebBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['TOKENGRAPH_GITHUB_WEB'] ?? 'https://github.com').replace(/\/+$/, '');
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}
export class GitHubAuthError extends GitHubError {}
export class GitHubNotFoundError extends GitHubError {}
export class GitHubRateLimitError extends GitHubError {
  constructor(
    message: string,
    status: number,
    readonly resetAt: Date | null,
  ) {
    super(message, status);
  }
}

export interface GistFile {
  filename: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

export interface Gist {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  files: Record<string, GistFile | null>;
}

export interface GitHubUser {
  login: string;
  /** Classic OAuth scopes; null when GitHub does not say (fine-grained tokens). */
  scopes: string[] | null;
}

export interface GitHubClient {
  getUser(): Promise<GitHubUser>;
  /** Every gist of the authenticated user, secret ones included; files carry no content. */
  listGists(): Promise<Gist[]>;
  getGist(id: string): Promise<Gist>;
  createGist(input: { description: string; public: boolean; files: Record<string, string> }): Promise<Gist>;
  /** Only the listed files change; null deletes a file. */
  updateGist(id: string, files: Record<string, string | null>): Promise<Gist>;
}

export interface GitHubClientOptions {
  token: () => Promise<string>;
  apiBase?: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

const MAX_GIST_PAGES = 30;

function rateLimitReset(headers: Headers): Date | null {
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000);
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return new Date(Date.now() + retryAfter * 1000);
  return null;
}

async function errorFor(response: Response): Promise<GitHubError> {
  let message = `GitHub answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') message = `${message}: ${body.message}`;
  } catch {
    // Not JSON; the status says enough.
  }
  const limited =
    response.status === 429 ||
    (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
  if (limited) return new GitHubRateLimitError(message, response.status, rateLimitReset(response.headers));
  if (response.status === 401) return new GitHubAuthError(message, 401);
  if (response.status === 404) return new GitHubNotFoundError(message, 404);
  return new GitHubError(message, response.status);
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const base = (options.apiBase ?? githubApiBase()).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? `tokengraph/${cliVersion()}`;

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
      Authorization: `Bearer ${await options.token()}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GitHubError(`Could not reach GitHub (${reason})`, 0);
    }
    if (!response.ok) throw await errorFor(response);
    return response;
  }

  async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await send(method, path, body)).json()) as T;
  }

  async function fillTruncated(gist: Gist): Promise<Gist> {
    for (const file of Object.values(gist.files)) {
      if (!file?.truncated || !file.raw_url) continue;
      let response: Response;
      try {
        // Raw URLs need no token, and it is not sent anywhere it is not needed.
        response = await doFetch(file.raw_url, { headers: { 'User-Agent': userAgent } });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new GitHubError(`Could not reach GitHub (${reason})`, 0);
      }
      if (!response.ok) throw await errorFor(response);
      file.content = await response.text();
      file.truncated = false;
    }
    return gist;
  }

  return {
    async getUser() {
      const response = await send('GET', '/user');
      const user = (await response.json()) as { login: string };
      const header = response.headers.get('x-oauth-scopes');
      const scopes = header === null ? null : header.split(',').map((scope) => scope.trim()).filter(Boolean);
      return { login: user.login, scopes };
    },
    async listGists() {
      const all: Gist[] = [];
      for (let page = 1; page <= MAX_GIST_PAGES; page += 1) {
        const batch = await sendJson<Gist[]>('GET', `/gists?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    async getGist(id) {
      return fillTruncated(await sendJson<Gist>('GET', `/gists/${encodeURIComponent(id)}`));
    },
    async createGist(input) {
      const files = Object.fromEntries(Object.entries(input.files).map(([name, content]) => [name, { content }]));
      return sendJson<Gist>('POST', '/gists', { description: input.description, public: input.public, files });
    },
    async updateGist(id, files) {
      const body = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, content === null ? null : { content }]));
      return sendJson<Gist>('PATCH', `/gists/${encodeURIComponent(id)}`, { files: body });
    },
  };
}
```

- [ ] **Step 3: Run tests** — `npx vitest run packages/cli/test/github-http.test.ts` → PASS.
- [ ] **Step 4: Commit** (`Add a GitHub API client for gists`).

---

### Task 5: Device flow

**Files:**
- Create: `packages/cli/src/github/device-flow.ts`, `packages/cli/test/github-device-flow.test.ts`

**Interfaces:**
- Consumes: `githubWebBase()` from Task 4.
- Produces:

```ts
export const GITHUB_CLIENT_ID = 'Ov23liunAdVeHoVD4vgm';
export const GITHUB_SCOPE = 'gist';
export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }
export type DeviceFlowFailure = 'expired' | 'denied' | 'disabled' | 'failed';
export class DeviceFlowError extends Error { readonly reason: DeviceFlowFailure }
export interface DeviceFlowDeps { fetch?: typeof fetch; webBase?: string; clientId?: string; sleep?: (ms: number) => Promise<void>; now?: () => number }
export function requestDeviceCode(deps?: DeviceFlowDeps): Promise<DeviceCode>;
export function pollForToken(code: DeviceCode, deps?: DeviceFlowDeps): Promise<{ accessToken: string; scopes: string[] }>;
```

- [ ] **Step 1: Write the failing tests** — `packages/cli/test/github-device-flow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DeviceFlowError, GITHUB_CLIENT_ID, pollForToken, requestDeviceCode, type DeviceCode } from '../src/github/device-flow.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sequence(bodies: unknown[]) {
  const calls: { url: string; body: string }[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: String(init.body) });
    return json(bodies[Math.min(calls.length - 1, bodies.length - 1)]);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const code: DeviceCode = { deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };

function clock() {
  let now = 0;
  const slept: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; }, slept };
}

describe('requestDeviceCode', () => {
  it('asks for the gist scope with the public client id', async () => {
    const { fetch, calls } = sequence([{ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }]);
    expect(await requestDeviceCode({ fetch, webBase: 'https://gh.test' })).toEqual(code);
    expect(calls[0]!.url).toBe('https://gh.test/login/device/code');
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('client_id')).toBe(GITHUB_CLIENT_ID);
    expect(params.get('scope')).toBe('gist');
  });

  it('explains a disabled device flow', async () => {
    const { fetch } = sequence([{ error: 'device_flow_disabled' }]);
    await expect(requestDeviceCode({ fetch })).rejects.toMatchObject({ reason: 'disabled' });
  });
});

describe('pollForToken', () => {
  it('waits while pending and returns the token', async () => {
    const { fetch, calls } = sequence([{ error: 'authorization_pending' }, { access_token: 'gho_x', token_type: 'bearer', scope: 'gist' }]);
    const time = clock();
    expect(await pollForToken(code, { fetch, ...time })).toEqual({ accessToken: 'gho_x', scopes: ['gist'] });
    expect(time.slept).toEqual([5000, 5000]);
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(params.get('device_code')).toBe('dev');
    expect(params.has('client_secret')).toBe(false);
  });

  it('slows down when asked', async () => {
    const { fetch } = sequence([{ error: 'slow_down', interval: 10 }, { error: 'slow_down' }, { access_token: 'gho_x', scope: 'gist' }]);
    const time = clock();
    await pollForToken(code, { fetch, ...time });
    expect(time.slept).toEqual([5000, 10000, 15000]);
  });

  it('stops on denial and on expiry', async () => {
    await expect(pollForToken(code, { fetch: sequence([{ error: 'access_denied' }]).fetch, ...clock() })).rejects.toMatchObject({ reason: 'denied' });
    await expect(pollForToken(code, { fetch: sequence([{ error: 'expired_token' }]).fetch, ...clock() })).rejects.toMatchObject({ reason: 'expired' });
    const short = { ...code, expiresIn: 12 };
    await expect(pollForToken(short, { fetch: sequence([{ error: 'authorization_pending' }]).fetch, ...clock() })).rejects.toBeInstanceOf(DeviceFlowError);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `packages/cli/src/github/device-flow.ts`**

```ts
import { githubWebBase } from './http.js';

/** The public "tokengraph" OAuth App. Device flow needs no client secret, and none exists. */
export const GITHUB_CLIENT_ID = 'Ov23liunAdVeHoVD4vgm';
/** Write access to gists and nothing else. */
export const GITHUB_SCOPE = 'gist';

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
}

export type DeviceFlowFailure = 'expired' | 'denied' | 'disabled' | 'failed';

const MESSAGES: Record<DeviceFlowFailure, string> = {
  expired: 'The code expired before it was approved. Run `tokengraph login` again.',
  denied: 'The request was cancelled on GitHub.',
  disabled: 'GitHub refused the device flow for this app. Please report this at https://github.com/altindalorcun/tokengraph/issues',
  failed: 'GitHub could not complete the login.',
};

export class DeviceFlowError extends Error {
  constructor(
    readonly reason: DeviceFlowFailure,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[reason]} (${detail})` : MESSAGES[reason]);
    this.name = 'DeviceFlowError';
  }
}

export interface DeviceFlowDeps {
  fetch?: typeof fetch;
  webBase?: string;
  clientId?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function post(deps: DeviceFlowDeps, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const doFetch = deps.fetch ?? fetch;
  const base = (deps.webBase ?? githubWebBase()).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (error) {
    throw new DeviceFlowError('failed', error instanceof Error ? error.message : String(error));
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new DeviceFlowError('failed', `HTTP ${response.status}`);
  }
}

function failureFor(error: unknown): DeviceFlowError {
  if (error === 'expired_token') return new DeviceFlowError('expired');
  if (error === 'access_denied') return new DeviceFlowError('denied');
  if (error === 'device_flow_disabled') return new DeviceFlowError('disabled');
  return new DeviceFlowError('failed', typeof error === 'string' ? error : undefined);
}

export async function requestDeviceCode(deps: DeviceFlowDeps = {}): Promise<DeviceCode> {
  const body = await post(deps, '/login/device/code', { client_id: deps.clientId ?? GITHUB_CLIENT_ID, scope: GITHUB_SCOPE });
  if (typeof body['device_code'] !== 'string' || typeof body['user_code'] !== 'string') throw failureFor(body['error']);
  return {
    deviceCode: body['device_code'],
    userCode: body['user_code'],
    verificationUri: typeof body['verification_uri'] === 'string' ? body['verification_uri'] : 'https://github.com/login/device',
    expiresIn: typeof body['expires_in'] === 'number' ? body['expires_in'] : 900,
    interval: typeof body['interval'] === 'number' ? body['interval'] : 5,
  };
}

export async function pollForToken(code: DeviceCode, deps: DeviceFlowDeps = {}): Promise<{ accessToken: string; scopes: string[] }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const body = await post(deps, '/login/oauth/access_token', {
      client_id: deps.clientId ?? GITHUB_CLIENT_ID,
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof body['access_token'] === 'string') {
      const scope = typeof body['scope'] === 'string' ? body['scope'] : '';
      return { accessToken: body['access_token'], scopes: scope.split(/[,\s]+/).filter(Boolean) };
    }
    if (body['error'] === 'authorization_pending') continue;
    if (body['error'] === 'slow_down') {
      interval = typeof body['interval'] === 'number' ? body['interval'] : interval + 5;
      continue;
    }
    throw failureFor(body['error']);
  }
  throw new DeviceFlowError('expired');
}
```

- [ ] **Step 3: Run tests** → PASS. **Step 4: Commit** (`Add GitHub device flow login`).

---

### Task 6: Small terminal helpers — clipboard, browser opener, yes/no prompt

**Files:**
- Create: `packages/cli/src/clipboard.ts`, `packages/cli/src/open-url.ts`, `packages/cli/src/prompt.ts`
- Create tests: `packages/cli/test/clipboard.test.ts`, `packages/cli/test/prompt.test.ts`

**Interfaces:**
- Produces:

```ts
// clipboard.ts
export interface ClipboardDeps { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; run: (command: string, args: string[], input: string) => Promise<boolean> }
export function clipboardCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): [string, string[]][];
export function copyToClipboard(text: string, deps?: Partial<ClipboardDeps>): Promise<boolean>;
// open-url.ts
export function openUrl(url: string): void;
export function revealInFileManager(path: string): void;
// prompt.ts
export interface PromptIO { input: NodeJS.ReadableStream & { isTTY?: boolean }; output: NodeJS.WritableStream }
export function askYesNo(question: string, options?: { defaultYes?: boolean; io?: PromptIO }): Promise<boolean>;
```

- [ ] **Step 1: Failing tests**

`packages/cli/test/clipboard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clipboardCommands, copyToClipboard } from '../src/clipboard.js';

describe('clipboardCommands', () => {
  it('picks the platform tool', () => {
    expect(clipboardCommands('darwin', {})).toEqual([['pbcopy', []]]);
    expect(clipboardCommands('win32', {})).toEqual([['clip', []]]);
    expect(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' })[0]).toEqual(['wl-copy', []]);
    expect(clipboardCommands('linux', {}).map(([command]) => command)).toEqual(['xclip', 'xsel']);
  });
});

describe('copyToClipboard', () => {
  it('tries the next tool when one is missing', async () => {
    const tried: string[] = [];
    const ok = await copyToClipboard('hi', {
      platform: 'linux',
      env: {},
      run: async (command, _args, input) => {
        tried.push(`${command}:${input}`);
        return command === 'xsel';
      },
    });
    expect(ok).toBe(true);
    expect(tried).toEqual(['xclip:hi', 'xsel:hi']);
  });

  it('reports failure without throwing', async () => {
    expect(await copyToClipboard('hi', { platform: 'linux', env: {}, run: async () => false })).toBe(false);
  });
});
```

`packages/cli/test/prompt.test.ts`:

```ts
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { askYesNo } from '../src/prompt.js';

function io(answer: string, tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = new PassThrough();
  setTimeout(() => input.write(`${answer}\n`), 5);
  return { input, output };
}

describe('askYesNo', () => {
  it('reads yes, no and the default', async () => {
    expect(await askYesNo('Go?', { io: io('y') })).toBe(true);
    expect(await askYesNo('Go?', { io: io('n') })).toBe(false);
    expect(await askYesNo('Go?', { io: io('') })).toBe(true);
    expect(await askYesNo('Go?', { defaultYes: false, io: io('') })).toBe(false);
  });

  it('never blocks without a terminal', async () => {
    expect(await askYesNo('Go?', { io: io('', false) })).toBe(true);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

`packages/cli/src/clipboard.ts`:

```ts
import { spawn } from 'node:child_process';

export interface ClipboardDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Runs a command with `input` on stdin; true when it exits 0. */
  run: (command: string, args: string[], input: string) => Promise<boolean>;
}

export function clipboardCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): [string, string[]][] {
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  const x11: [string, string[]][] = [
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
  return env['WAYLAND_DISPLAY'] ? [['wl-copy', []], ...x11] : x11;
}

function runWithInput(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 2000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.stdin.end(input);
    } catch {
      resolve(false);
    }
  });
}

/** Best effort: the text is always printed too, so a machine without a clipboard tool loses nothing. */
export async function copyToClipboard(text: string, deps: Partial<ClipboardDeps> = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runWithInput;
  for (const [command, args] of clipboardCommands(platform, env)) {
    if (await run(command, args, text)) return true;
  }
  return false;
}
```

`packages/cli/src/open-url.ts`:

```ts
import { spawn } from 'node:child_process';

function launch(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL or path is printed as well, so a missing opener is not a failure.
  }
}

export function openUrl(url: string): void {
  if (process.platform === 'darwin') launch('open', [url]);
  else if (process.platform === 'win32') launch('cmd', ['/c', 'start', '', url]);
  else launch('xdg-open', [url]);
}

/** Shows a saved file in Finder / Explorer, selected; on Linux opens its folder. */
export function revealInFileManager(path: string): void {
  if (process.platform === 'darwin') launch('open', ['-R', path]);
  else if (process.platform === 'win32') launch('explorer', [`/select,${path}`]);
  else launch('xdg-open', [path.replace(/[\\/][^\\/]*$/, '') || '.']);
}
```

`packages/cli/src/prompt.ts`:

```ts
import { createInterface } from 'node:readline/promises';

export interface PromptIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/** A [Y/n] question. Without a terminal it never waits: it returns the default. */
export async function askYesNo(question: string, options: { defaultYes?: boolean; io?: PromptIO } = {}): Promise<boolean> {
  const defaultYes = options.defaultYes ?? true;
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  if (!io.input.isTTY) return defaultYes;
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const answer = (await rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 3: Run tests** → PASS. **Step 4: Commit** (`Add clipboard, browser and prompt helpers`).

---

### Task 7: GitHub auth — stored token or the `gh` CLI

**Files:**
- Create: `packages/cli/src/github/auth.ts`, `packages/cli/test/github-auth.test.ts`

**Interfaces:**
- Consumes: `GitHubAuth` (Task 2), `GitHubAuthError`, `createGitHubClient`, `GitHubClient` (Task 4).
- Produces:

```ts
export type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;
export function findGh(env?: NodeJS.ProcessEnv, exists?: (path: string) => boolean): string | null;
export function ghToken(ghPath: string, exec?: ExecFile): Promise<string | null>;
export function tokenProvider(auth: GitHubAuth, exec?: ExecFile): () => Promise<string>;
export function clientFor(auth: GitHubAuth, options?: { exec?: ExecFile; fetch?: typeof fetch }): GitHubClient;
export function hasGistScope(scopes: string[] | null): boolean;
```

- [ ] **Step 1: Failing tests** — `packages/cli/test/github-auth.test.ts`:

```ts
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findGh, ghToken, hasGistScope, tokenProvider } from '../src/github/auth.js';
import { GitHubAuthError } from '../src/github/http.js';

describe('findGh', () => {
  it('finds gh on PATH', () => {
    const env = { PATH: ['/nope', '/tools/bin'].join(delimiter) };
    expect(findGh(env, (path) => path === join('/tools/bin', process.platform === 'win32' ? 'gh.exe' : 'gh'))).toBe(
      join('/tools/bin', process.platform === 'win32' ? 'gh.exe' : 'gh'),
    );
  });

  it('falls back to the usual install folders (launchd has a minimal PATH)', () => {
    if (process.platform === 'win32') return;
    expect(findGh({ PATH: '/usr/bin' }, (path) => path === '/opt/homebrew/bin/gh')).toBe('/opt/homebrew/bin/gh');
  });

  it('returns null when gh is not installed', () => {
    expect(findGh({ PATH: '/nope' }, () => false)).toBeNull();
  });
});

describe('ghToken', () => {
  it('reads and trims the token', async () => {
    expect(await ghToken('/bin/gh', async (_file, args) => {
      expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
      return { stdout: 'gho_abc\n' };
    })).toBe('gho_abc');
  });

  it('returns null when gh is logged out or fails', async () => {
    expect(await ghToken('/bin/gh', async () => { throw new Error('not logged in'); })).toBeNull();
    expect(await ghToken('/bin/gh', async () => ({ stdout: '\n' }))).toBeNull();
  });
});

describe('tokenProvider', () => {
  it('returns a stored token', async () => {
    expect(await tokenProvider({ kind: 'token', token: 'gho_x' })()).toBe('gho_x');
  });

  it('asks gh at use time and fails as an auth error when gh logged out', async () => {
    expect(await tokenProvider({ kind: 'gh', ghPath: '/bin/gh' }, async () => ({ stdout: 'gho_y' }))()).toBe('gho_y');
    await expect(tokenProvider({ kind: 'gh', ghPath: '/bin/gh' }, async () => { throw new Error('x'); })()).rejects.toBeInstanceOf(GitHubAuthError);
  });
});

describe('hasGistScope', () => {
  it('accepts gist, or unknown scopes (fine-grained tokens)', () => {
    expect(hasGistScope(['repo', 'gist'])).toBe(true);
    expect(hasGistScope(null)).toBe(true);
    expect(hasGistScope(['repo', 'read:org'])).toBe(false);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `packages/cli/src/github/auth.ts`**

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { GitHubAuth } from '../config.js';
import { createGitHubClient, GitHubAuthError, type GitHubClient } from './http.js';

export type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync: ExecFile = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, { timeout: 10_000, windowsHide: true });
  return { stdout: String(stdout) };
};

// launchd and cron start jobs with a minimal PATH, so the usual install folders are checked too.
const COMMON_GH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin'];

export function findGh(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | null {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const dirs = [...(env['PATH'] ?? '').split(delimiter).filter(Boolean), ...(process.platform === 'win32' ? [] : COMMON_GH_DIRS)];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export async function ghToken(ghPath: string, exec: ExecFile = execFileAsync): Promise<string | null> {
  try {
    const token = (await exec(ghPath, ['auth', 'token', '--hostname', 'github.com'])).stdout.trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/**
 * For a gh-backed login the token is read from gh every time, so tokengraph never stores a copy of
 * a token that may carry `repo` scope, and a token gh refreshes keeps working.
 */
export function tokenProvider(auth: GitHubAuth, exec: ExecFile = execFileAsync): () => Promise<string> {
  if (auth.kind === 'token') return async () => auth.token;
  return async () => {
    const token = await ghToken(auth.ghPath, exec);
    if (!token) throw new GitHubAuthError(`The GitHub CLI at ${auth.ghPath} is not logged in any more.`, 401);
    return token;
  };
}

export function clientFor(auth: GitHubAuth, options: { exec?: ExecFile; fetch?: typeof fetch } = {}): GitHubClient {
  return createGitHubClient({ token: tokenProvider(auth, options.exec), fetch: options.fetch });
}

/** Classic tokens list their scopes; fine-grained ones do not, and their gist access shows on first use. */
export function hasGistScope(scopes: string[] | null): boolean {
  return scopes === null || scopes.includes('gist');
}
```

- [ ] **Step 3: Run tests** → PASS. **Step 4: Commit** (`Resolve GitHub auth from a stored token or gh`).

---

### Task 8: Machine files and the stable machine fingerprint

**Files:**
- Create: `packages/cli/src/publish/machines.ts`, `packages/cli/src/publish/machine-identity.ts`, `packages/cli/src/publish/machines-cache.ts`
- Create tests: `packages/cli/test/publish-machines.test.ts`, `packages/cli/test/machine-identity.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `parseLedger`, `mergeUsage`, `ledgerToUsage`, `allLedgerUsage`, `LEDGER_VERSION` from `ledger.ts`; `machinesCachePath()` from Task 2.
- Produces:

```ts
// machines.ts
export interface MachineFile { schema: 1; machineId: string; label: string; fingerprint: string; cliVersion: string; updatedAt: string; sources: Ledger['sources'] }
export function machineFileName(machineId: string): string;            // `machine-${id}.json`
export function isMachineFileName(name: string): boolean;
export function machineLabel(platform: NodeJS.Platform, machineId: string): string; // `${platform}-${id.slice(0, 6)}`
export function parseMachineFile(content: string): MachineFile | null;
export function serializeMachineFile(file: MachineFile): string;
export function sourcesDigest(sources: Ledger['sources']): string;
export function maxMergeLedgers(base: Ledger, extra: Ledger['sources']): Ledger;
export function activeDayCount(sources: Ledger['sources']): number;
export function combinedUsage(local: Ledger, others: readonly MachineFile[], sinceDate?: string): DailyModelUsage[];
export function resolveMachineId(input: { configured?: string; files: readonly MachineFile[]; fingerprint: string; newId: () => string }): { machineId: string; adopted: MachineFile | null };
// machine-identity.ts
export interface IdentityDeps { platform: NodeJS.Platform; exec: (file: string, args: string[]) => Promise<{ stdout: string }>; readFile: (path: string) => Promise<string>; hostname: () => string; username: () => string }
export function osMachineId(deps?: Partial<IdentityDeps>): Promise<string | null>;
export function machineFingerprint(rawMachineId: string, username: string): string;
export function currentFingerprint(deps?: Partial<IdentityDeps>): Promise<string>;
// machines-cache.ts
export function readMachinesCache(path?: string): Promise<MachineFile[]>;
export function writeMachinesCache(files: readonly MachineFile[], path?: string): Promise<void>;
```

- [ ] **Step 1: Failing tests** — `packages/cli/test/publish-machines.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeUsage, type Ledger } from '../src/ledger.js';
import {
  activeDayCount,
  combinedUsage,
  isMachineFileName,
  machineFileName,
  machineLabel,
  maxMergeLedgers,
  parseMachineFile,
  resolveMachineId,
  serializeMachineFile,
  sourcesDigest,
  type MachineFile,
} from '../src/publish/machines.js';
import { readMachinesCache, writeMachinesCache } from '../src/publish/machines-cache.js';

const A = '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40';
const B = '11111111-2222-4333-8444-555555555555';
const counts = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: null, cacheCreation1hTokens: null });

function ledgerWith(date: string, input: number): Ledger {
  return mergeUsage(emptyLedger(), 'claude-code', [{ date, model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(input) }]);
}

function file(machineId: string, ledger: Ledger, fingerprint = 'fp'): MachineFile {
  return { schema: 1, machineId, label: machineLabel('darwin', machineId), fingerprint, cliVersion: '0.1.0', updatedAt: '2026-10-13T10:00:00.000Z', sources: ledger.sources };
}

describe('machine file names', () => {
  it('round-trip', () => {
    expect(machineFileName(A)).toBe(`machine-${A}.json`);
    expect(isMachineFileName(machineFileName(A))).toBe(true);
    expect(isMachineFileName('tokengraph-data.md')).toBe(false);
    expect(machineLabel('darwin', A)).toBe('darwin-3f2a1c');
  });
});

describe('parse / serialize', () => {
  it('round-trips and rejects junk', () => {
    const original = file(A, ledgerWith('2026-10-01', 5));
    expect(parseMachineFile(serializeMachineFile(original))).toEqual(original);
    expect(parseMachineFile('not json')).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...original, schema: 2 }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...original, machineId: 'x' }))).toBeNull();
  });
});

describe('sourcesDigest', () => {
  it('ignores key order', () => {
    const one = mergeUsage(ledgerWith('2026-10-01', 5), 'codex', [{ date: '2026-10-02', model: 'gpt-5.5', pricingTier: 'standard', counts: counts(1) }]);
    const two = mergeUsage(mergeUsage(emptyLedger(), 'codex', [{ date: '2026-10-02', model: 'gpt-5.5', pricingTier: 'standard', counts: counts(1) }]), 'claude-code', [
      { date: '2026-10-01', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(5) },
    ]);
    expect(sourcesDigest(one.sources)).toBe(sourcesDigest(two.sources));
    expect(sourcesDigest(one.sources)).not.toBe(sourcesDigest(ledgerWith('2026-10-01', 6).sources));
  });
});

describe('maxMergeLedgers', () => {
  it('takes the larger count and restores missing days, never shrinking', () => {
    const local = ledgerWith('2026-10-02', 10);
    const remote = mergeUsage(ledgerWith('2026-10-02', 7), 'claude-code', [{ date: '2026-09-01', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(3) }]);
    const merged = maxMergeLedgers(local, remote.sources);
    expect(merged.sources['claude-code']!['2026-10-02']!['claude-opus-5-5']!.standard!.inputTokens).toBe(10);
    expect(merged.sources['claude-code']!['2026-09-01']!['claude-opus-5-5']!.standard!.inputTokens).toBe(3);
    expect(activeDayCount(merged.sources)).toBe(2);
  });
});

describe('combinedUsage', () => {
  it('sums other machines and never the local machine with itself', () => {
    const local = ledgerWith('2026-10-01', 10);
    const usage = combinedUsage(local, [file(B, ledgerWith('2026-10-01', 4))]);
    expect(usage.reduce((sum, entry) => sum + entry.counts.inputTokens, 0)).toBe(14);
  });

  it('applies the since date', () => {
    expect(combinedUsage(ledgerWith('2025-01-01', 10), [], '2026-01-01')).toEqual([]);
  });
});

describe('resolveMachineId', () => {
  const files = [file(B, ledgerWith('2026-10-01', 1), 'mine')];

  it('keeps a configured id', () => {
    expect(resolveMachineId({ configured: A, files, fingerprint: 'mine', newId: () => 'unused' })).toEqual({ machineId: A, adopted: null });
  });

  it('adopts the file with this machine fingerprint after a reinstall', () => {
    expect(resolveMachineId({ files, fingerprint: 'mine', newId: () => 'unused' })).toEqual({ machineId: B, adopted: files[0] });
  });

  it('creates a new id otherwise', () => {
    expect(resolveMachineId({ files, fingerprint: 'other', newId: () => A })).toEqual({ machineId: A, adopted: null });
  });
});

describe('machines cache', () => {
  it('round-trips and tolerates a missing file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tg-cache-')), 'machines.json');
    expect(await readMachinesCache(path)).toEqual([]);
    const files = [file(B, ledgerWith('2026-10-01', 1))];
    await writeMachinesCache(files, path);
    expect(await readMachinesCache(path)).toEqual(files);
  });
});
```

`packages/cli/test/machine-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { currentFingerprint, machineFingerprint, osMachineId } from '../src/publish/machine-identity.js';

const fail = async () => {
  throw new Error('nope');
};

describe('osMachineId', () => {
  it('reads IOPlatformUUID on macOS', async () => {
    const stdout = '  "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n';
    expect(await osMachineId({ platform: 'darwin', exec: async () => ({ stdout }) })).toBe('ABCDEF01-2345-6789-ABCD-EF0123456789');
  });

  it('reads /etc/machine-id on Linux', async () => {
    expect(await osMachineId({ platform: 'linux', readFile: async (path) => (path === '/etc/machine-id' ? 'abc123\n' : fail()) })).toBe('abc123');
  });

  it('reads MachineGuid on Windows', async () => {
    const stdout = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    1234-abcd\r\n';
    expect(await osMachineId({ platform: 'win32', exec: async () => ({ stdout }) })).toBe('1234-abcd');
  });

  it('returns null when nothing can be read', async () => {
    expect(await osMachineId({ platform: 'linux', readFile: fail })).toBeNull();
  });
});

describe('fingerprints', () => {
  it('are hashes, stable, and differ per user', () => {
    const one = machineFingerprint('id', 'alice');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).toBe(machineFingerprint('id', 'alice'));
    expect(one).not.toBe(machineFingerprint('id', 'bob'));
    expect(one).not.toContain('alice');
  });

  it('falls back to the hostname', async () => {
    const fp = await currentFingerprint({ platform: 'linux', readFile: fail, hostname: () => 'box', username: () => 'alice' });
    expect(fp).toBe(machineFingerprint('box', 'alice'));
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `packages/cli/src/publish/machines.ts`**

```ts
import { createHash } from 'node:crypto';
import type { DailyModelUsage } from '@tokengraph/core';
import { allLedgerUsage, emptyLedger, LEDGER_VERSION, ledgerToUsage, mergeUsage, parseLedger, type Ledger } from '../ledger.js';
import { isKnownSource } from '@tokengraph/core';

export interface MachineFile {
  schema: 1;
  machineId: string;
  /** `<platform>-<first 6 of id>`: tells machines apart without a hostname, which can carry a name. */
  label: string;
  /** sha256 of the OS machine id and user name, for re-adopting this id after a reinstall. */
  fingerprint: string;
  cliVersion: string;
  updatedAt: string;
  sources: Ledger['sources'];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^machine-([0-9a-f-]{36})\.json$/i;

export function machineFileName(machineId: string): string {
  return `machine-${machineId}.json`;
}

export function isMachineFileName(name: string): boolean {
  const match = FILE_NAME.exec(name);
  return match !== null && UUID.test(match[1]!);
}

export function machineLabel(platform: NodeJS.Platform, machineId: string): string {
  return `${platform}-${machineId.slice(0, 6)}`;
}

export function parseMachineFile(content: string): MachineFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (f['schema'] !== 1) return null;
  const machineId = f['machineId'];
  if (typeof machineId !== 'string' || !UUID.test(machineId)) return null;
  const strings = ['label', 'fingerprint', 'cliVersion', 'updatedAt'] as const;
  for (const key of strings) if (typeof f[key] !== 'string') return null;
  const ledger = parseLedger({ version: LEDGER_VERSION, sources: f['sources'] });
  return {
    schema: 1,
    machineId: machineId.toLowerCase(),
    label: f['label'] as string,
    fingerprint: f['fingerprint'] as string,
    cliVersion: f['cliVersion'] as string,
    updatedAt: f['updatedAt'] as string,
    sources: ledger.sources,
  };
}

export function serializeMachineFile(file: MachineFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Content identity of a machine's usage, independent of key order, to skip writes that change nothing. */
export function sourcesDigest(sources: Ledger['sources']): string {
  return createHash('sha256').update(JSON.stringify(stable(sources))).digest('hex');
}

/** Within one machine totals only grow: the gist copy can restore days the local ledger lost, never shrink any. */
export function maxMergeLedgers(base: Ledger, extra: Ledger['sources']): Ledger {
  let merged = base;
  const extraLedger: Ledger = { version: LEDGER_VERSION, sources: extra };
  for (const source of Object.keys(extra).filter(isKnownSource)) {
    merged = mergeUsage(merged, source, ledgerToUsage(extraLedger, source));
  }
  return merged;
}

export function activeDayCount(sources: Ledger['sources']): number {
  const dates = new Set<string>();
  for (const days of Object.values(sources)) for (const date of Object.keys(days ?? {})) dates.add(date);
  return dates.size;
}

/** This machine's usage plus every other machine's: different machines are different usage, so they add up. */
export function combinedUsage(local: Ledger, others: readonly MachineFile[], sinceDate?: string): DailyModelUsage[] {
  return [
    ...allLedgerUsage(local, sinceDate),
    ...others.flatMap((other) => allLedgerUsage({ ...emptyLedger(), sources: other.sources }, sinceDate)),
  ];
}

export function resolveMachineId(input: {
  configured?: string;
  files: readonly MachineFile[];
  fingerprint: string;
  newId: () => string;
}): { machineId: string; adopted: MachineFile | null } {
  if (input.configured) return { machineId: input.configured, adopted: null };
  const matches = input.files.filter((file) => file.fingerprint === input.fingerprint).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (matches[0]) return { machineId: matches[0].machineId, adopted: matches[0] };
  return { machineId: input.newId(), adopted: null };
}
```
(Merge the two `@tokengraph/core` imports into one statement.)

- [ ] **Step 3: Implement `packages/cli/src/publish/machine-identity.ts`**

```ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { promisify } from 'node:util';

export interface IdentityDeps {
  platform: NodeJS.Platform;
  exec: (file: string, args: string[]) => Promise<{ stdout: string }>;
  readFile: (path: string) => Promise<string>;
  hostname: () => string;
  username: () => string;
}

const DEFAULTS: IdentityDeps = {
  platform: process.platform,
  exec: async (file, args) => ({ stdout: String((await promisify(execFile)(file, args, { timeout: 5000, windowsHide: true })).stdout) }),
  readFile: (path) => readFile(path, 'utf8'),
  hostname,
  username: () => {
    try {
      return userInfo().username;
    } catch {
      return process.env['USER'] ?? process.env['USERNAME'] ?? '';
    }
  },
};

/** The OS's own stable machine id. Hostnames are not stable on macOS (they follow the network). */
export async function osMachineId(overrides: Partial<IdentityDeps> = {}): Promise<string | null> {
  const deps = { ...DEFAULTS, ...overrides };
  try {
    if (deps.platform === 'darwin') {
      const { stdout } = await deps.exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1] ?? null;
    }
    if (deps.platform === 'win32') {
      const { stdout } = await deps.exec('reg', ['query', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1] ?? null;
    }
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = (await deps.readFile(path)).trim();
        if (id) return id;
      } catch {
        // try the next one
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function machineFingerprint(rawMachineId: string, username: string): string {
  return createHash('sha256').update(`tokengraph:${rawMachineId}:${username}`).digest('hex');
}

export async function currentFingerprint(overrides: Partial<IdentityDeps> = {}): Promise<string> {
  const deps = { ...DEFAULTS, ...overrides };
  const id = (await osMachineId(deps)) ?? deps.hostname();
  return machineFingerprint(id, deps.username());
}
```

- [ ] **Step 4: Implement `packages/cli/src/publish/machines-cache.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { machinesCachePath } from '../paths.js';
import { parseMachineFile, serializeMachineFile, type MachineFile } from './machines.js';

/** Other machines' files from the last publish, so offline commands (story) show all-machine numbers. */
export async function readMachinesCache(path = machinesCachePath()): Promise<MachineFile[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { schema?: unknown; files?: unknown };
    if (raw.schema !== 1 || !Array.isArray(raw.files)) return [];
    return raw.files.flatMap((entry) => {
      const parsed = typeof entry === 'string' ? parseMachineFile(entry) : null;
      return parsed ? [parsed] : [];
    });
  } catch {
    return [];
  }
}

export async function writeMachinesCache(files: readonly MachineFile[], path = machinesCachePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ schema: 1, files: files.map(serializeMachineFile) }), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
```

- [ ] **Step 5: Run tests** → PASS. **Step 6: Commit** (`Add machine files, fingerprints and the offline machines cache`).

---

### Task 9: Gist discovery and the publish pipeline

**Files:**
- Create: `packages/cli/src/publish/gists.ts`, `packages/cli/src/publish/publish.ts`, `packages/cli/src/readme-snippet.ts`
- Create tests: `packages/cli/test/publish-gists.test.ts`, `packages/cli/test/publish.test.ts`, `packages/cli/test/readme-snippet.test.ts`, `packages/cli/test/fake-github-client.ts` (in-memory `GitHubClient` for unit tests)

**Interfaces:**
- Consumes: Tasks 3, 4, 8 (`renderPublishedGraphs`, `PUBLISHED_GRAPH_FILES`, `GitHubClient`, `Gist`, `GitHubNotFoundError`, machine helpers), `CliConfig` (Task 2).
- Produces:

```ts
// readme-snippet.ts
export const PROJECT_URL = 'https://github.com/altindalorcun/tokengraph';
export function rawGistUrl(login: string, gistId: string, file: string): string;
export function readmeSnippet(login: string, gistId: string, options?: { compact?: boolean }): string;
// gists.ts
export const GRAPH_MARKER = 'tokengraph-dark.svg';
export const DATA_MARKER = 'tokengraph-data.md';
export const GRAPH_DESCRIPTION: string;
export const DATA_DESCRIPTION: string;
export function graphGistReadme(login: string, gistId: string): string;
export function dataGistReadme(): string;
export interface GistLookup { list(): Promise<Gist[]> }
export function gistLookup(client: GitHubClient): GistLookup;   // lists at most once
export function ensureDataGist(client: GitHubClient, cachedId: string | undefined, lookup: GistLookup): Promise<{ gist: Gist; created: boolean }>;
export function ensureGraphGist(client: GitHubClient, cachedId: string | undefined, lookup: GistLookup, initialFiles: Record<string, string>): Promise<{ gist: Gist; created: boolean; replacedCached: boolean }>;
// publish.ts
export interface PublishInput { client: GitHubClient; login: string; config: CliConfig; ledger: Ledger; today: string; nowIso: string; cliVersion: string; platform: NodeJS.Platform; fingerprint: string; newMachineId: () => string }
export interface PublishResult { ledger: Ledger; config: CliConfig; graphGistId: string; dataGistId: string; others: MachineFile[]; adopted: boolean; restoredDays: number; wroteMachineFile: boolean; updatedGraphFiles: string[]; graphGistCreated: boolean; graphGistReplaced: boolean }
export function publish(input: PublishInput): Promise<PublishResult>;
```

- [ ] **Step 1: The in-memory client used by unit tests** — `packages/cli/test/fake-github-client.ts`:

```ts
import { GitHubNotFoundError, type Gist, type GitHubClient } from '../src/github/http.js';

export interface FakeGitHub extends GitHubClient {
  gists: Map<string, Gist>;
  calls: { method: string; id?: string; files?: Record<string, string | null> }[];
}

let next = 1;

export function fakeGitHubClient(login = 'octocat'): FakeGitHub {
  const gists = new Map<string, Gist>();
  const calls: FakeGitHub['calls'] = [];
  const copy = (gist: Gist): Gist => structuredClone(gist);
  return {
    gists,
    calls,
    async getUser() {
      calls.push({ method: 'getUser' });
      return { login, scopes: ['gist'] };
    },
    async listGists() {
      calls.push({ method: 'listGists' });
      return [...gists.values()].map((gist) => ({ ...copy(gist), files: Object.fromEntries(Object.keys(gist.files).map((name) => [name, { filename: name }])) }));
    },
    async getGist(id) {
      calls.push({ method: 'getGist', id });
      const gist = gists.get(id);
      if (!gist) throw new GitHubNotFoundError('Not Found', 404);
      return copy(gist);
    },
    async createGist(input) {
      const id = (next++).toString(16).padStart(20, 'a');
      calls.push({ method: 'createGist', id, files: input.files });
      const gist: Gist = {
        id,
        description: input.description,
        public: input.public,
        html_url: `https://gist.github.com/${login}/${id}`,
        files: Object.fromEntries(Object.entries(input.files).map(([name, content]) => [name, { filename: name, content }])),
      };
      gists.set(id, gist);
      return copy(gist);
    },
    async updateGist(id, files) {
      calls.push({ method: 'updateGist', id, files });
      const gist = gists.get(id);
      if (!gist) throw new GitHubNotFoundError('Not Found', 404);
      for (const [name, content] of Object.entries(files)) {
        if (content === null) delete gist.files[name];
        else gist.files[name] = { filename: name, content };
      }
      return copy(gist);
    },
  };
}
```

- [ ] **Step 2: Failing snippet test** — `packages/cli/test/readme-snippet.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rawGistUrl, readmeSnippet } from '../src/readme-snippet.js';

describe('readme snippet', () => {
  it('links raw files without a revision', () => {
    expect(rawGistUrl('octocat', 'abc', 'tokengraph-dark.svg')).toBe('https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-dark.svg');
  });

  it('switches theme with <picture> and links the project', () => {
    const snippet = readmeSnippet('octocat', 'abc');
    expect(snippet).toContain('<a href="https://github.com/altindalorcun/tokengraph">');
    expect(snippet).toContain('media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-dark.svg"');
    expect(snippet).toContain('src="https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-light.svg"');
  });

  it('uses the compact files when asked', () => {
    expect(readmeSnippet('octocat', 'abc', { compact: true })).toContain('tokengraph-compact-dark.svg');
  });
});
```

- [ ] **Step 3: Implement `packages/cli/src/readme-snippet.ts`**

```ts
export const PROJECT_URL = 'https://github.com/altindalorcun/tokengraph';
const RAW_BASE = 'https://gist.githubusercontent.com';

/** Without a revision segment the raw URL always serves the gist's latest file. */
export function rawGistUrl(login: string, gistId: string, file: string): string {
  return `${RAW_BASE}/${login}/${gistId}/raw/${file}`;
}

export function readmeSnippet(login: string, gistId: string, options: { compact?: boolean } = {}): string {
  const prefix = options.compact ? 'tokengraph-compact' : 'tokengraph';
  return [
    `<a href="${PROJECT_URL}">`,
    '  <picture>',
    `    <source media="(prefers-color-scheme: dark)" srcset="${rawGistUrl(login, gistId, `${prefix}-dark.svg`)}">`,
    `    <img alt="My AI coding token usage, made with tokengraph" src="${rawGistUrl(login, gistId, `${prefix}-light.svg`)}">`,
    '  </picture>',
    '</a>',
  ].join('\n');
}
```

- [ ] **Step 4: Failing gist tests** — `packages/cli/test/publish-gists.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DATA_MARKER, ensureDataGist, ensureGraphGist, GRAPH_MARKER, gistLookup, graphGistReadme } from '../src/publish/gists.js';
import { fakeGitHubClient } from './fake-github-client.js';

const svgs = { [GRAPH_MARKER]: '<svg/>' };

describe('ensureDataGist', () => {
  it('creates a secret gist with the marker when none exists', async () => {
    const client = fakeGitHubClient();
    const { gist, created } = await ensureDataGist(client, undefined, gistLookup(client));
    expect(created).toBe(true);
    expect(gist.public).toBe(false);
    expect(Object.keys(gist.files)).toContain(DATA_MARKER);
  });

  it('finds an existing one by marker (second machine) and lists only once', async () => {
    const client = fakeGitHubClient();
    const first = await ensureDataGist(client, undefined, gistLookup(client));
    const lookup = gistLookup(client);
    const again = await ensureDataGist(client, undefined, lookup);
    await ensureGraphGist(client, undefined, lookup, svgs);
    expect(again.created).toBe(false);
    expect(again.gist.id).toBe(first.gist.id);
    expect(client.calls.filter((call) => call.method === 'listGists')).toHaveLength(1);
  });

  it('uses the cached id without listing', async () => {
    const client = fakeGitHubClient();
    const first = await ensureDataGist(client, undefined, gistLookup(client));
    client.calls.length = 0;
    await ensureDataGist(client, first.gist.id, gistLookup(client));
    expect(client.calls.map((call) => call.method)).toEqual(['getGist']);
  });
});

describe('ensureGraphGist', () => {
  it('creates a public gist with the rendered files', async () => {
    const client = fakeGitHubClient();
    const { gist, created, replacedCached } = await ensureGraphGist(client, undefined, gistLookup(client), svgs);
    expect([created, replacedCached, gist.public]).toEqual([true, false, true]);
    expect(gist.files[GRAPH_MARKER]?.content).toBe('<svg/>');
  });

  it('recreates a gist the user deleted and says so', async () => {
    const client = fakeGitHubClient();
    const first = await ensureGraphGist(client, undefined, gistLookup(client), svgs);
    client.gists.delete(first.gist.id);
    const again = await ensureGraphGist(client, first.gist.id, gistLookup(client), svgs);
    expect(again.created).toBe(true);
    expect(again.replacedCached).toBe(true);
    expect(again.gist.id).not.toBe(first.gist.id);
  });
});

describe('graphGistReadme', () => {
  it('shows the graph and links the project', () => {
    const readme = graphGistReadme('octocat', 'abc');
    expect(readme).toContain('https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-dark.svg');
    expect(readme).toContain('npx tokengraph');
  });
});
```

- [ ] **Step 5: Implement `packages/cli/src/publish/gists.ts`**

```ts
import { GitHubNotFoundError, type Gist, type GitHubClient } from '../github/http.js';
import { PROJECT_URL, readmeSnippet } from '../readme-snippet.js';

export const GRAPH_MARKER = 'tokengraph-dark.svg';
export const DATA_MARKER = 'tokengraph-data.md';
export const GRAPH_DESCRIPTION = 'My AI coding token graph · made with tokengraph (npx tokengraph)';
export const DATA_DESCRIPTION = 'tokengraph data, written by the tokengraph CLI. Do not edit.';

export function graphGistReadme(login: string, gistId: string): string {
  return [
    '# My AI coding token graph',
    '',
    readmeSnippet(login, gistId),
    '',
    `Made with [tokengraph](${PROJECT_URL}): a GitHub-style graph of the tokens your AI coding agents burn each day.`,
    'Try it: `npx tokengraph`',
    '',
  ].join('\n');
}

export function dataGistReadme(): string {
  return [
    '# tokengraph data',
    '',
    `This secret gist is written by the [tokengraph](${PROJECT_URL}) CLI. Each \`machine-<id>.json\` file holds one`,
    "machine's daily token counts per agent and model, so your machines add up to one graph and a reinstall",
    'gets its history back. It holds token counts only: no prompts, no code, no file names.',
    '',
    'Secret gists are unlisted, not private: anyone with this URL can read it. Do not edit the files by hand.',
    '',
  ].join('\n');
}

export interface GistLookup {
  list(): Promise<Gist[]>;
}

/** Listing every gist is the expensive call, so one publish does it at most once. */
export function gistLookup(client: GitHubClient): GistLookup {
  let listed: Promise<Gist[]> | null = null;
  return { list: () => (listed ??= client.listGists()) };
}

async function getIfExists(client: GitHubClient, id: string | undefined): Promise<Gist | null> {
  if (!id) return null;
  try {
    return await client.getGist(id);
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return null;
    throw error;
  }
}

async function findByMarker(client: GitHubClient, lookup: GistLookup, marker: string): Promise<Gist | null> {
  const found = (await lookup.list()).find((gist) => marker in gist.files);
  return found ? getIfExists(client, found.id) : null;
}

export async function ensureDataGist(client: GitHubClient, cachedId: string | undefined, lookup: GistLookup): Promise<{ gist: Gist; created: boolean }> {
  const existing = (await getIfExists(client, cachedId)) ?? (await findByMarker(client, lookup, DATA_MARKER));
  if (existing) return { gist: existing, created: false };
  const gist = await client.createGist({ description: DATA_DESCRIPTION, public: false, files: { [DATA_MARKER]: dataGistReadme() } });
  return { gist, created: true };
}

export async function ensureGraphGist(
  client: GitHubClient,
  cachedId: string | undefined,
  lookup: GistLookup,
  initialFiles: Record<string, string>,
): Promise<{ gist: Gist; created: boolean; replacedCached: boolean }> {
  const cached = await getIfExists(client, cachedId);
  if (cached) return { gist: cached, created: false, replacedCached: false };
  const found = await findByMarker(client, lookup, GRAPH_MARKER);
  if (found) return { gist: found, created: false, replacedCached: cachedId !== undefined && found.id !== cachedId };
  const gist = await client.createGist({ description: GRAPH_DESCRIPTION, public: true, files: initialFiles });
  return { gist, created: true, replacedCached: cachedId !== undefined };
}
```

- [ ] **Step 6: Failing publish tests** — `packages/cli/test/publish.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeUsage, type Ledger } from '../src/ledger.js';
import { GRAPH_MARKER } from '../src/publish/gists.js';
import { machineFileName, parseMachineFile } from '../src/publish/machines.js';
import { publish, type PublishInput } from '../src/publish/publish.js';
import { fakeGitHubClient, type FakeGitHub } from './fake-github-client.js';

const A = '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40';
const B = '11111111-2222-4333-8444-555555555555';
const counts = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
const ledgerWith = (date: string, input: number): Ledger =>
  mergeUsage(emptyLedger(), 'claude-code', [{ date, model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(input) }]);

function input(client: FakeGitHub, overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    client,
    login: 'octocat',
    config: { github: { login: 'octocat', auth: { kind: 'token', token: 't' } } },
    ledger: ledgerWith('2026-10-12', 1000),
    today: '2026-10-13',
    nowIso: '2026-10-13T10:00:00.000Z',
    cliVersion: '0.1.0',
    platform: 'darwin',
    fingerprint: 'fp-a',
    newMachineId: () => A,
    ...overrides,
  };
}

describe('publish', () => {
  it('first run: creates both gists, writes the machine file and the graph', async () => {
    const client = fakeGitHubClient();
    const result = await publish(input(client));
    expect(result.config.machineId).toBe(A);
    expect(result.config.gists).toEqual({ graph: result.graphGistId, data: result.dataGistId });
    expect(result.graphGistCreated).toBe(true);
    expect(result.wroteMachineFile).toBe(true);
    const data = client.gists.get(result.dataGistId)!;
    expect(data.public).toBe(false);
    expect(parseMachineFile(data.files[machineFileName(A)]!.content!)?.fingerprint).toBe('fp-a');
    const graph = client.gists.get(result.graphGistId)!;
    expect(graph.public).toBe(true);
    expect(graph.files['README.md']!.content).toContain(result.graphGistId);
    expect(JSON.stringify(graph.files)).not.toContain('claude-opus-5-5');
  });

  it('second run with nothing new sends no writes', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    client.calls.length = 0;
    const second = await publish(input(client, { config: first.config, nowIso: '2026-10-13T11:00:00.000Z' }));
    expect(second.wroteMachineFile).toBe(false);
    expect(second.updatedGraphFiles).toEqual([]);
    expect(client.calls.filter((call) => call.method !== 'getGist')).toEqual([]);
  });

  it('a second machine adds up, and only ever writes its own file', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    const second = await publish(
      input(client, { config: { github: first.config.github }, ledger: ledgerWith('2026-10-12', 500), fingerprint: 'fp-b', newMachineId: () => B }),
    );
    expect(second.config.machineId).toBe(B);
    expect(second.others.map((other) => other.machineId)).toEqual([A]);
    const patches = client.calls.filter((call) => call.method === 'updateGist' && call.id === second.dataGistId);
    for (const patch of patches) expect(Object.keys(patch.files!)).toEqual([machineFileName(B)]);
  });

  it('restores lost local history from its own file and never shrinks', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client, { ledger: mergeUsage(ledgerWith('2026-10-12', 1000), 'claude-code', [{ date: '2026-08-01', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(9) }]) }));
    const wiped = await publish(input(client, { config: first.config, ledger: ledgerWith('2026-10-12', 10) }));
    expect(wiped.restoredDays).toBe(1);
    expect(wiped.ledger.sources['claude-code']!['2026-10-12']!['claude-opus-5-5']!.standard!.inputTokens).toBe(1000);
  });

  it('adopts its old id after ~/.tokengraph was wiped (same fingerprint)', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    const again = await publish(input(client, { config: { github: first.config.github }, newMachineId: () => B }));
    expect(again.adopted).toBe(true);
    expect(again.config.machineId).toBe(A);
    expect(again.others).toEqual([]);
  });

  it('recreates a deleted graph gist and reports it', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    client.gists.delete(first.graphGistId);
    const again = await publish(input(client, { config: first.config }));
    expect(again.graphGistReplaced).toBe(true);
    expect(again.graphGistId).not.toBe(first.graphGistId);
    expect(client.gists.get(again.graphGistId)!.files[GRAPH_MARKER]).toBeDefined();
  });

  it('ignores files in the data gist that are not machine files or do not parse', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    client.gists.get(first.dataGistId)!.files['machine-zzz.json'] = { filename: 'machine-zzz.json', content: 'garbage' };
    await expect(publish(input(client, { config: first.config }))).resolves.toMatchObject({ others: [] });
  });
});
```

- [ ] **Step 7: Implement `packages/cli/src/publish/publish.ts`**

```ts
import { addDays, dateKey, GRAPH_WINDOW_DAYS, renderPublishedGraphs } from '@tokengraph/core';
import type { CliConfig } from '../config.js';
import type { Gist, GitHubClient } from '../github/http.js';
import type { Ledger } from '../ledger.js';
import { ensureDataGist, ensureGraphGist, gistLookup, graphGistReadme } from './gists.js';
import {
  activeDayCount,
  combinedUsage,
  isMachineFileName,
  machineFileName,
  machineLabel,
  maxMergeLedgers,
  parseMachineFile,
  resolveMachineId,
  serializeMachineFile,
  sourcesDigest,
  type MachineFile,
} from './machines.js';

export interface PublishInput {
  client: GitHubClient;
  login: string;
  config: CliConfig;
  /** This machine's ledger after collecting. */
  ledger: Ledger;
  /** Local date key the graph ends on. */
  today: string;
  nowIso: string;
  cliVersion: string;
  platform: NodeJS.Platform;
  fingerprint: string;
  newMachineId: () => string;
}

export interface PublishResult {
  /** The ledger after merging this machine's own gist copy back in (save it). */
  ledger: Ledger;
  /** The config with machine id and gist ids filled in (save it). */
  config: CliConfig;
  graphGistId: string;
  dataGistId: string;
  /** Every other machine's file, for the offline cache. */
  others: MachineFile[];
  adopted: boolean;
  /** Days this machine's ledger gained back from its gist copy. */
  restoredDays: number;
  wroteMachineFile: boolean;
  updatedGraphFiles: string[];
  graphGistCreated: boolean;
  /** A cached graph gist was gone: the README snippet changed. */
  graphGistReplaced: boolean;
}

function machineFiles(gist: Gist): MachineFile[] {
  return Object.entries(gist.files).flatMap(([name, file]) => {
    if (!file?.content || !isMachineFileName(name)) return [];
    const parsed = parseMachineFile(file.content);
    return parsed && machineFileName(parsed.machineId) === name ? [parsed] : [];
  });
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const { client } = input;
  const lookup = gistLookup(client);

  // 1. The data gist: who else publishes, and this machine's own backup.
  const data = await ensureDataGist(client, input.config.gists?.data, lookup);
  const files = machineFiles(data.gist);
  const { machineId, adopted } = resolveMachineId({
    configured: input.config.machineId,
    files,
    fingerprint: input.fingerprint,
    newId: input.newMachineId,
  });
  const own = files.find((file) => file.machineId === machineId) ?? null;
  const others = files.filter((file) => file.machineId !== machineId);

  // 2. Within one machine totals only grow: take back anything the local ledger lost.
  const ledger = own ? maxMergeLedgers(input.ledger, own.sources) : input.ledger;
  const restoredDays = activeDayCount(ledger.sources) - activeDayCount(input.ledger.sources);

  // 3. Write this machine's file only when its usage changed; never touch another machine's file.
  let wroteMachineFile = false;
  if (!own || sourcesDigest(own.sources) !== sourcesDigest(ledger.sources)) {
    const file: MachineFile = {
      schema: 1,
      machineId,
      label: machineLabel(input.platform, machineId),
      fingerprint: input.fingerprint,
      cliVersion: input.cliVersion,
      updatedAt: input.nowIso,
      sources: ledger.sources,
    };
    await client.updateGist(data.gist.id, { [machineFileName(machineId)]: serializeMachineFile(file) });
    wroteMachineFile = true;
  }

  // 4. The graph: every machine summed, rendered, and only changed files sent.
  const since = dateKey(addDays(new Date(`${input.today}T12:00:00Z`), -GRAPH_WINDOW_DAYS), 'UTC');
  const colors = input.config.graph?.colors ?? 'model';
  const svgs: Record<string, string> = renderPublishedGraphs(combinedUsage(ledger, others, since), { today: input.today, colors });
  const graph = await ensureGraphGist(client, input.config.gists?.graph, lookup, svgs);
  const wanted: Record<string, string> = { ...svgs, 'README.md': graphGistReadme(input.login, graph.gist.id) };
  const changed = Object.fromEntries(Object.entries(wanted).filter(([name, content]) => graph.gist.files[name]?.content !== content));
  if (Object.keys(changed).length > 0) await client.updateGist(graph.gist.id, changed);

  return {
    ledger,
    config: { ...input.config, machineId, gists: { graph: graph.gist.id, data: data.gist.id } },
    graphGistId: graph.gist.id,
    dataGistId: data.gist.id,
    others,
    adopted: adopted !== null,
    restoredDays: Math.max(0, restoredDays),
    wroteMachineFile,
    updatedGraphFiles: Object.keys(changed).sort(),
    graphGistCreated: graph.created,
    graphGistReplaced: graph.replacedCached,
  };
}
```
Check `dateKey`'s real signature in `packages/core/src/dates.ts` and adapt both call sites (Task 3 and here) the same way.

- [ ] **Step 8: Run tests** — `npx vitest run packages/cli/test/publish packages/cli/test/readme-snippet.test.ts` → PASS.
- [ ] **Step 9: Commit** (`Publish the graph and machine files to gists`).

---

### Task 10: `sync` publishes

**Files:**
- Modify: `packages/cli/src/commands/sync.ts`, `packages/cli/test/sync.test.ts`

**Interfaces:**
- Consumes: Tasks 7–9, `readConfig`/`writeConfig`, `writeMachinesCache`, `currentFingerprint`, `cliVersion`, `readmeSnippet`.
- Produces: `SyncOptions` gains `quiet?: boolean` (prints only the publish summary) and `deps?: Partial<SyncPublishDeps>`:

```ts
export interface SyncPublishDeps {
  clientFor: (auth: GitHubAuth) => GitHubClient;
  fingerprint: () => Promise<string>;
  newMachineId: () => string;
  now: () => Date;
}
```

- [ ] **Step 1: Failing tests** — add to `packages/cli/test/sync.test.ts` (use the file's existing fixture setup that gives Claude Code usage; keep its patterns for `CLAUDE_CONFIG_DIR`):

```ts
import { fakeGitHubClient } from './fake-github-client.js';
import { writeConfig, readConfig } from '../src/config.js';
import { GitHubRateLimitError } from '../src/github/http.js';
import { readLedger } from '../src/ledger.js';
import { ledgerPath } from '../src/paths.js';
import { readMachinesCache } from '../src/publish/machines-cache.js';

describe('sync publishing', () => {
  it('stays local when not logged in', async () => {
    const client = fakeGitHubClient();
    expect(await runSync({ sinceDays: 30, theme: 'light', deps: { clientFor: () => client } })).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('publishes when logged in and saves machine id and gist ids', async () => {
    const client = fakeGitHubClient();
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } } });
    const code = await runSync({
      sinceDays: 30,
      theme: 'light',
      deps: { clientFor: () => client, fingerprint: async () => 'fp', newMachineId: () => '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40' },
    });
    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.machineId).toBe('3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40');
    expect(config.gists?.graph).toBeDefined();
    expect(await readMachinesCache()).toEqual([]);
  });

  it('--local never touches GitHub', async () => {
    const client = fakeGitHubClient();
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } } });
    await runSync({ sinceDays: 30, theme: 'light', local: true, deps: { clientFor: () => client } });
    expect(client.calls).toEqual([]);
  });

  it('keeps the ledger and exits 1 when GitHub rate-limits', async () => {
    const client = fakeGitHubClient();
    client.getGist = async () => {
      throw new GitHubRateLimitError('limited', 403, new Date('2026-10-13T12:00:00Z'));
    };
    client.listGists = client.getGist as never;
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } } });
    expect(await runSync({ sinceDays: 30, theme: 'light', deps: { clientFor: () => client, fingerprint: async () => 'fp' } })).toBe(1);
    expect(Object.keys((await readLedger(ledgerPath())).sources).length).toBeGreaterThan(0);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement in `sync.ts`**

Add the options and deps to `SyncOptions`, wrap the per-source/day printing in `if (!options.quiet)`, and replace the tail added in Task 2 with:

```ts
  if (options.local) {
    if (!options.quiet) console.log('\nSaved locally (--local).');
    return 0;
  }
  const config = await readConfig();
  if (!config.github) {
    console.log('\nSaved locally. Run `tokengraph login` to put this graph in your GitHub README.');
    return 0;
  }
  return publishFromSync(ledger, config, options);
}

const DEFAULT_PUBLISH_DEPS: SyncPublishDeps = {
  clientFor: (auth) => clientFor(auth),
  fingerprint: () => currentFingerprint(),
  newMachineId: () => randomUUID(),
  now: () => new Date(),
};

async function publishFromSync(ledger: Ledger, config: CliConfig & { github: GitHubAccount }, options: SyncOptions): Promise<number> {
  const deps = { ...DEFAULT_PUBLISH_DEPS, ...options.deps };
  const now = deps.now();
  let result: PublishResult;
  try {
    result = await publish({
      client: deps.clientFor(config.github.auth),
      login: config.github.login,
      config,
      ledger,
      today: dateKey(now),
      nowIso: now.toISOString(),
      cliVersion: cliVersion(),
      platform: process.platform,
      fingerprint: await deps.fingerprint(),
      newMachineId: deps.newMachineId,
    });
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      console.error('\nGitHub no longer accepts this login. Run `tokengraph login` again. Your usage is saved locally.');
    } else if (error instanceof GitHubRateLimitError) {
      const when = error.resetAt ? ` after ${error.resetAt.toLocaleTimeString()}` : ' later';
      console.error(`\nGitHub is rate-limiting requests; the graph will update on a sync${when}. Your usage is saved locally.`);
    } else if (error instanceof GitHubError) {
      console.error(`\nCould not publish: ${error.message}. Your usage is saved locally.`);
    } else {
      throw error;
    }
    return 1;
  }

  if (result.restoredDays > 0 || result.ledger !== ledger) await writeLedger(ledgerPath(), result.ledger);
  await writeConfig(result.config);
  await writeMachinesCache(result.others);

  const graphUrl = `https://gist.github.com/${config.github.login}/${result.graphGistId}`;
  if (result.adopted) console.log(`\nRestored this machine's history (${result.restoredDays} days) from your data gist.`);
  else if (result.restoredDays > 0) console.log(`\nRecovered ${result.restoredDays} days from your data gist.`);
  if (result.others.length > 0) console.log(`\nCombined with ${result.others.length} other machine${result.others.length === 1 ? '' : 's'}.`);
  if (result.graphGistReplaced) {
    console.log('\n⚠ Your graph gist was missing, so a new one was made. Update your README with:\n');
    console.log(readmeSnippet(config.github.login, result.graphGistId));
  }
  console.log(result.updatedGraphFiles.length > 0 ? `\n✓ Graph published: ${graphUrl}` : `\n✓ Graph up to date: ${graphUrl}`);
  return 0;
}
```
Imports to add: `randomUUID` from `node:crypto`; `readConfig`, `writeConfig`, `CliConfig`, `GitHubAccount`, `GitHubAuth` from `../config.js`; `clientFor` from `../github/auth.js`; `GitHubAuthError`, `GitHubError`, `GitHubRateLimitError`, `GitHubClient` from `../github/http.js`; `currentFingerprint` from `../publish/machine-identity.js`; `writeMachinesCache` from `../publish/machines-cache.js`; `publish`, `PublishResult` from `../publish/publish.js`; `readmeSnippet` from `../readme-snippet.js`; `cliVersion` from `../bin-path.js`; `Ledger` from `../ledger.js`.

Also update the `sync` help text in `bin.ts`: "Reads every supported agent's local data into the ledger (~/.tokengraph/state.json), then, when you are logged in, publishes your graph to your gist. `--local` never touches the network."

- [ ] **Step 3: Run** `npx tsc --build && npx vitest run` → green. **Step 4: Commit** (`Publish from sync when logged in`).

---

### Task 11: `readme`, `status`, view status line, help

**Files:**
- Create: `packages/cli/src/commands/readme.ts`, `packages/cli/test/readme-command.test.ts`
- Modify: `packages/cli/src/commands/status.ts`, `packages/cli/src/bin.ts`

**Interfaces:**
- Produces: `export function runReadme(options: { compact: boolean; colors?: GraphColors; copy?: (text: string) => Promise<boolean> }): Promise<number>`

- [ ] **Step 1: Failing test** — `packages/cli/test/readme-command.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runReadme } from '../src/commands/readme.js';
import { readConfig, writeConfig } from '../src/config.js';

describe('readme', () => {
  it('asks to log in first', async () => {
    expect(await runReadme({ compact: false, copy: async () => true })).toBe(1);
  });

  it('prints and copies the snippet', async () => {
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } }, gists: { graph: 'aaaaaaaaaaaaaaaaaaaa' } });
    const copy = vi.fn(async () => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runReadme({ compact: true, copy })).toBe(0);
    expect(copy.mock.calls[0]![0]).toContain('tokengraph-compact-dark.svg');
    expect(log.mock.calls.flat().join('\n')).toContain('github.com/octocat/octocat');
    log.mockRestore();
  });

  it('saves a colour choice', async () => {
    await writeConfig({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } }, gists: { graph: 'aaaaaaaaaaaaaaaaaaaa' } });
    await runReadme({ compact: false, colors: 'single', copy: async () => true, republish: async () => 0 });
    expect((await readConfig()).graph).toEqual({ colors: 'single' });
  });
});
```
(The options type therefore also has `republish?: () => Promise<number>`, defaulting to `runSync({ sinceDays: 30, theme: 'light', quiet: true })`.)

- [ ] **Step 2: Implement `packages/cli/src/commands/readme.ts`**

```ts
import { copyToClipboard } from '../clipboard.js';
import { readConfig, writeConfig, type GraphColors } from '../config.js';
import { readmeSnippet } from '../readme-snippet.js';
import { runSync } from './sync.js';

export interface ReadmeOptions {
  compact: boolean;
  colors?: GraphColors;
  copy?: (text: string) => Promise<boolean>;
  republish?: () => Promise<number>;
}

export async function runReadme(options: ReadmeOptions): Promise<number> {
  let config = await readConfig();
  if (!config.github) {
    console.error('Run `tokengraph login` first: the graph lives in a gist on your GitHub account.');
    return 1;
  }
  if (options.colors && options.colors !== (config.graph?.colors ?? 'model')) {
    config = { ...config, graph: { colors: options.colors } };
    await writeConfig(config);
    const code = await (options.republish ?? (() => runSync({ sinceDays: 30, theme: 'light', quiet: true })))();
    if (code !== 0) return code;
    config = await readConfig();
  }
  if (!config.gists?.graph) {
    console.error('No graph published yet. Run `tokengraph sync`.');
    return 1;
  }
  const login = config.github.login;
  const snippet = readmeSnippet(login, config.gists.graph, { compact: options.compact });
  const copied = await (options.copy ?? copyToClipboard)(snippet);
  console.log(`\nAdd this to your profile README${copied ? ' (it is on your clipboard)' : ''}:\n`);
  console.log(snippet);
  console.log(`\nYour profile README is the README.md of the repo named after you: https://github.com/${login}/${login}`);
  console.log("(Don't have it yet? Create a public repo named exactly like your username and tick \"Add a README\".)");
  return 0;
}
```

Bin entry:

```ts
  readme: {
    help: `Usage: tokengraph readme [options]

Prints the snippet that shows your graph in a GitHub README and copies it to the clipboard. The
graph switches between light and dark with the reader's theme.

Options:
  --compact            A smaller graph without labels and legends
  --colors <mode>      model (each day takes its model family's colour) or single; republishes
`,
    options: { compact: { type: 'boolean', default: false }, colors: { type: 'string' } },
    run: (values) => {
      const colors = values['colors'];
      if (colors !== undefined && colors !== 'model' && colors !== 'single') {
        console.error('--colors must be model or single.');
        return 1;
      }
      return runReadme({ compact: values['compact'] === true, colors });
    },
  },
```
USAGE line: `  readme               Print the README snippet for your graph (and copy it)`.

- [ ] **Step 3: Status** — in `status.ts` after the machine line add:

```ts
  if (config.gists?.graph && config.github) console.log(`graph:   https://gist.github.com/${config.github.login}/${config.gists.graph}`);
  if (config.gists?.data && config.github) console.log(`data:    https://gist.github.com/${config.github.login}/${config.gists.data} (secret)`);
  const others = await readMachinesCache();
  if (others.length > 0) {
    console.log('other machines (as of the last publish):');
    for (const other of others) console.log(`  ${other.label}  updated ${other.updatedAt.slice(0, 10)}  ${activeDayCount(other.sources)} days`);
  }
```
Update the status test file (whatever exists for status) to cover the logged-in lines with a written config.

- [ ] **Step 4: Run** `npx tsc --build && npx vitest run` → green. **Step 5: Commit** (`Add the readme command and show gists in status`).

---

### Task 12: `login` and `logout`

**Files:**
- Create: `packages/cli/src/commands/login.ts`, `packages/cli/src/commands/login-finish.ts`, `packages/cli/test/login.test.ts`
- Rewrite: `packages/cli/src/commands/logout.ts`, add `packages/cli/test/logout.test.ts`
- Modify: `packages/cli/src/bin.ts`

**Interfaces:**
- Consumes: Tasks 4–7, `readConfig`/`writeConfig`, `ephemeralInstallError` from `bin-path.ts`, `runSchedule` from `commands/schedule.ts`, `runSync` with `quiet` (Task 10), `runReadme` (Task 11).
- Produces:

```ts
export interface LoginOptions { method: 'auto' | 'gh' | 'device'; openBrowser: boolean }
export interface LoginDeps {
  isTTY: boolean;
  findGh: () => string | null;
  ghToken: (ghPath: string) => Promise<string | null>;
  clientForToken: (token: string) => GitHubClient;
  requestDeviceCode: () => Promise<DeviceCode>;
  pollForToken: (code: DeviceCode) => Promise<{ accessToken: string; scopes: string[] }>;
  ask: (question: string) => Promise<boolean>;
  copy: (text: string) => Promise<boolean>;
  open: (url: string) => void;
  firstPublish: () => Promise<number>;
  offerSchedule: () => Promise<void>;
}
export function runLogin(options: LoginOptions, overrides?: Partial<LoginDeps>): Promise<number>;
export function runLogout(): Promise<number>;
```

- [ ] **Step 1: Failing tests** — `packages/cli/test/login.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runLogin, type LoginDeps } from '../src/commands/login.js';
import { readConfig } from '../src/config.js';
import type { GitHubClient } from '../src/github/http.js';

const code = { deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };

function userClient(login: string, scopes: string[] | null): GitHubClient {
  return { getUser: async () => ({ login, scopes }) } as unknown as GitHubClient;
}

function deps(overrides: Partial<LoginDeps> = {}): Partial<LoginDeps> {
  return {
    isTTY: true,
    findGh: () => null,
    ghToken: async () => null,
    clientForToken: () => userClient('octocat', ['gist']),
    requestDeviceCode: async () => code,
    pollForToken: async () => ({ accessToken: 'gho_device', scopes: ['gist'] }),
    ask: async () => true,
    copy: async () => true,
    open: () => undefined,
    firstPublish: async () => 0,
    offerSchedule: async () => undefined,
    ...overrides,
  };
}

describe('login', () => {
  it('device flow: stores the token and publishes', async () => {
    const firstPublish = vi.fn(async () => 0);
    expect(await runLogin({ method: 'auto', openBrowser: false }, deps({ firstPublish }))).toBe(0);
    expect((await readConfig()).github).toEqual({ login: 'octocat', auth: { kind: 'token', token: 'gho_device' } });
    expect(firstPublish).toHaveBeenCalledOnce();
  });

  it('offers gh and stores only its path', async () => {
    const result = await runLogin(
      { method: 'auto', openBrowser: false },
      deps({ findGh: () => '/opt/homebrew/bin/gh', ghToken: async () => 'gho_gh', clientForToken: () => userClient('octocat', ['repo', 'gist']) }),
    );
    expect(result).toBe(0);
    expect((await readConfig()).github).toEqual({ login: 'octocat', auth: { kind: 'gh', ghPath: '/opt/homebrew/bin/gh' } });
  });

  it('falls back to the device flow when gh lacks the gist scope', async () => {
    const requestDeviceCode = vi.fn(async () => code);
    await runLogin(
      { method: 'auto', openBrowser: false },
      deps({ findGh: () => '/bin/gh', ghToken: async () => 'gho_gh', clientForToken: (token) => userClient('octocat', token === 'gho_gh' ? ['repo'] : ['gist']), requestDeviceCode }),
    );
    expect(requestDeviceCode).toHaveBeenCalledOnce();
    expect((await readConfig()).github?.auth.kind).toBe('token');
  });

  it('--gh fails clearly when gh cannot be used', async () => {
    expect(await runLogin({ method: 'gh', openBrowser: false }, deps())).toBe(1);
  });

  it('copies the one-time code', async () => {
    const copy = vi.fn(async () => true);
    await runLogin({ method: 'device', openBrowser: false }, deps({ copy }));
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
  });

  it('keeps an existing machine id', async () => {
    const { writeConfig } = await import('../src/config.js');
    await writeConfig({ machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40' });
    await runLogin({ method: 'device', openBrowser: false }, deps());
    expect((await readConfig()).machineId).toBe('3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40');
  });
});
```
(`setup-home.ts` gives each test file a temp `TOKENGRAPH_HOME`; if tests in one file share it, `beforeEach` delete `config.json` via `rm(configPath(), { force: true })`.)

`packages/cli/test/logout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runLogout } from '../src/commands/logout.js';
import { readConfig, writeConfig } from '../src/config.js';

describe('logout', () => {
  it('forgets the account and gists but keeps the machine id', async () => {
    await writeConfig({
      machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40',
      github: { login: 'octocat', auth: { kind: 'token', token: 'gho_x' } },
      gists: { graph: 'aaaaaaaaaaaaaaaaaaaa', data: 'bbbbbbbbbbbbbbbbbbbb' },
      graph: { colors: 'single' },
    });
    expect(await runLogout()).toBe(0);
    expect(await readConfig()).toEqual({ machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40', graph: { colors: 'single' } });
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `packages/cli/src/commands/login.ts`**

```ts
import { readConfig, writeConfig, type GitHubAuth } from '../config.js';
import { clientFor, findGh, ghToken, hasGistScope } from '../github/auth.js';
import { DeviceFlowError, pollForToken, requestDeviceCode, type DeviceCode } from '../github/device-flow.js';
import { createGitHubClient, GitHubError, type GitHubClient } from '../github/http.js';
import { copyToClipboard } from '../clipboard.js';
import { openUrl } from '../open-url.js';
import { askYesNo } from '../prompt.js';

export interface LoginOptions {
  method: 'auto' | 'gh' | 'device';
  openBrowser: boolean;
}

export interface LoginDeps {
  isTTY: boolean;
  findGh: () => string | null;
  ghToken: (ghPath: string) => Promise<string | null>;
  clientForToken: (token: string) => GitHubClient;
  requestDeviceCode: () => Promise<DeviceCode>;
  pollForToken: (code: DeviceCode) => Promise<{ accessToken: string; scopes: string[] }>;
  ask: (question: string) => Promise<boolean>;
  copy: (text: string) => Promise<boolean>;
  open: (url: string) => void;
  /** Runs the first sync + publish and prints the README snippet. */
  firstPublish: () => Promise<number>;
  /** Offers the hourly schedule (or explains how to get it from an npx run). */
  offerSchedule: () => Promise<void>;
}

const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[22m` : text);

function defaultDeps(): LoginDeps {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    findGh: () => findGh(),
    ghToken: (path) => ghToken(path),
    clientForToken: (token) => createGitHubClient({ token: async () => token }),
    requestDeviceCode: () => requestDeviceCode(),
    pollForToken: (code) => pollForToken(code),
    ask: (question) => askYesNo(question),
    copy: (text) => copyToClipboard(text),
    open: openUrl,
    firstPublish: async () => (await import('./login-finish.js')).firstPublish(),
    offerSchedule: async () => (await import('./login-finish.js')).offerSchedule(),
  };
}

async function tryGh(options: LoginOptions, deps: LoginDeps): Promise<{ auth: GitHubAuth; login: string } | null> {
  const ghPath = deps.findGh();
  if (!ghPath) return null;
  const token = await deps.ghToken(ghPath);
  if (!token) return null;
  let user;
  try {
    user = await deps.clientForToken(token).getUser();
  } catch {
    return null;
  }
  if (!hasGistScope(user.scopes)) {
    if (options.method === 'gh') console.error(`Your GitHub CLI token has no "gist" scope. Run: gh auth refresh -s gist`);
    return null;
  }
  if (options.method !== 'gh' && !(deps.isTTY && (await deps.ask(`Use your GitHub CLI account ${bold(`@${user.login}`)}?`)))) return null;
  return { auth: { kind: 'gh', ghPath }, login: user.login };
}

async function deviceFlow(options: LoginOptions, deps: LoginDeps): Promise<{ auth: GitHubAuth; login: string }> {
  const code = await deps.requestDeviceCode();
  const copied = await deps.copy(code.userCode);
  console.log('');
  console.log(`  Your one-time code:  ${bold(code.userCode)}${copied ? '   (copied)' : ''}`);
  console.log(`  Enter it at:         ${code.verificationUri}`);
  console.log('');
  if (options.openBrowser && deps.isTTY) deps.open(code.verificationUri);
  console.log('Waiting for you to approve tokengraph on GitHub…');
  const { accessToken } = await deps.pollForToken(code);
  const user = await deps.clientForToken(accessToken).getUser();
  if (!hasGistScope(user.scopes)) throw new DeviceFlowError('failed', 'the approved token cannot write gists');
  return { auth: { kind: 'token', token: accessToken }, login: user.login };
}

export async function runLogin(options: LoginOptions, overrides: Partial<LoginDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  let account: { auth: GitHubAuth; login: string } | null = null;
  try {
    if (options.method !== 'device') account = await tryGh(options, deps);
    if (!account && options.method === 'gh') {
      console.error('Could not use the GitHub CLI. Install it and run `gh auth login`, or run `tokengraph login` without --gh.');
      return 1;
    }
    account ??= await deviceFlow(options, deps);
  } catch (error) {
    if (error instanceof DeviceFlowError || error instanceof GitHubError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const config = await readConfig();
  await writeConfig({ ...config, github: { login: account.login, auth: account.auth } });
  console.log(`\n✓ Logged in as ${bold(`@${account.login}`)}${account.auth.kind === 'gh' ? ' (via the GitHub CLI)' : ''}\n`);

  const code = await deps.firstPublish();
  if (code === 0 && deps.isTTY) await deps.offerSchedule();
  return code;
}
```

Create `packages/cli/src/commands/login-finish.ts` (kept separate so `login.ts` stays testable without running a real sync):

```ts
import { ephemeralInstallError } from '../bin-path.js';
import { askYesNo } from '../prompt.js';
import { runReadme } from './readme.js';
import { runSchedule } from './schedule.js';
import { runSync } from './sync.js';

export async function firstPublish(): Promise<number> {
  const code = await runSync({ sinceDays: 400, theme: 'light', trigger: 'manual', quiet: true });
  if (code !== 0) return code;
  return runReadme({ compact: false });
}

export async function offerSchedule(): Promise<void> {
  const blocked = ephemeralInstallError('tokengraph schedule');
  if (blocked) {
    console.log('\nTo keep the graph updated every hour, install tokengraph and turn on the schedule:');
    console.log('  npm install -g tokengraph && tokengraph schedule');
    return;
  }
  if (await askYesNo('\nKeep your graph updated every hour?')) await runSchedule({});
}
```
`runSchedule`'s real options type is in `commands/schedule.ts`: pass whatever it needs for a plain install (check its signature).

- [ ] **Step 3: Implement `packages/cli/src/commands/logout.ts`**

```ts
import { readConfig, writeConfig } from '../config.js';

export async function runLogout(): Promise<number> {
  const config = await readConfig();
  if (!config.github) {
    console.log('Not logged in.');
    return 0;
  }
  const { github, gists, ...rest } = config;
  // The machine id stays: logging in again must continue this machine, never count it twice.
  await writeConfig(rest);
  console.log(`Logged out @${github.login} on this machine. Syncs stay local until you log in again.`);
  if (gists?.graph || gists?.data) console.log(`Your gists stay on GitHub: https://gist.github.com/${github.login}`);
  if (github.auth.kind === 'token') console.log("To revoke tokengraph's access: https://github.com/settings/applications");
  return 0;
}
```

- [ ] **Step 4: Wire `login` into `bin.ts`**

```ts
  login: {
    help: `Usage: tokengraph login [options]

Connects GitHub so sync can publish your graph to your own gist. Uses your GitHub CLI login when
you have one (asks first), otherwise a one-time code you approve in the browser. Asks for gist
access only.

Options:
  --gh                 Use the GitHub CLI login without asking
  --device             Always use a one-time code, even when the GitHub CLI is logged in
  --no-open            Do not open the browser automatically
`,
    options: {
      gh: { type: 'boolean', default: false },
      device: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
    },
    run: (values) => {
      if (values['gh'] && values['device']) {
        console.error('Choose one of --gh and --device.');
        return 1;
      }
      return runLogin({ method: values['gh'] ? 'gh' : values['device'] ? 'device' : 'auto', openBrowser: !values['no-open'] });
    },
  },
```
Add to USAGE: `  login                Connect GitHub to publish your graph to your own gist` and `  logout               Disconnect GitHub on this machine`.

- [ ] **Step 5: Run tests** → PASS (`npx vitest run packages/cli/test/login.test.ts packages/cli/test/logout.test.ts`). **Step 6: Commit** (`Log in with GitHub via gh or the device flow`).

---

### Task 13: End-to-end test against a fake GitHub server

**Files:**
- Create: `packages/cli/test/fake-github.ts` (node:http server), `packages/cli/test/e2e-publish.test.ts`

**Interfaces:**
- Consumes: everything above through real `fetch` and the env overrides `TOKENGRAPH_GITHUB_API` / `TOKENGRAPH_GITHUB_WEB`.
- Produces: `startFakeGitHub(): Promise<{ url: string; gists: Map<string, StoredGist>; close(): Promise<void>; approve(): void }>`.

- [ ] **Step 1: Write the server** — `packages/cli/test/fake-github.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StoredGist { id: string; description: string; public: boolean; files: Record<string, string> }

export async function startFakeGitHub(login = 'octocat') {
  const gists = new Map<string, StoredGist>();
  let approved = false;
  let nextId = 1;
  let url = '';

  const body = async (req: IncomingMessage) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    return text;
  };
  const send = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
  const view = (gist: StoredGist, withContent: boolean) => ({
    id: gist.id,
    description: gist.description,
    public: gist.public,
    html_url: `https://gist.github.com/${login}/${gist.id}`,
    files: Object.fromEntries(
      Object.entries(gist.files).map(([name, content]) => [
        name,
        withContent ? { filename: name, content, truncated: false, raw_url: `${url}/raw/${gist.id}/${name}` } : { filename: name },
      ]),
    ),
  });

  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    if (req.method === 'POST' && path === '/login/device/code') return send(res, 200, { device_code: 'dev', user_code: 'WDJB-MJHT', verification_uri: `${url}/login/device`, expires_in: 900, interval: 1 });
    if (req.method === 'POST' && path === '/login/oauth/access_token') {
      await body(req);
      return send(res, 200, approved ? { access_token: 'gho_fake', token_type: 'bearer', scope: 'gist' } : { error: 'authorization_pending' });
    }
    if (req.headers.authorization !== 'Bearer gho_fake' && !path.startsWith('/raw/')) return send(res, 401, { message: 'Bad credentials' });
    if (req.method === 'GET' && path === '/user') return send(res, 200, { login }, { 'x-oauth-scopes': 'gist' });
    if (req.method === 'GET' && path.startsWith('/gists?')) {
      const page = Number(new URL(path, url).searchParams.get('page') ?? '1');
      return send(res, 200, page === 1 ? [...gists.values()].map((gist) => view(gist, false)) : []);
    }
    const match = /^\/gists\/([^/?]+)$/.exec(path);
    if (req.method === 'POST' && path === '/gists') {
      const input = JSON.parse(await body(req)) as { description: string; public: boolean; files: Record<string, { content: string }> };
      const gist: StoredGist = { id: (nextId++).toString(16).padStart(32, '0'), description: input.description, public: input.public, files: Object.fromEntries(Object.entries(input.files).map(([n, f]) => [n, f.content])) };
      gists.set(gist.id, gist);
      return send(res, 201, view(gist, true));
    }
    if (match) {
      const gist = gists.get(match[1]!);
      if (!gist) return send(res, 404, { message: 'Not Found' });
      if (req.method === 'GET') return send(res, 200, view(gist, true));
      if (req.method === 'PATCH') {
        const input = JSON.parse(await body(req)) as { files: Record<string, { content: string } | null> };
        for (const [name, file] of Object.entries(input.files)) {
          if (file === null) delete gist.files[name];
          else gist.files[name] = file.content;
        }
        return send(res, 200, view(gist, true));
      }
    }
    const raw = /^\/raw\/([^/]+)\/(.+)$/.exec(path);
    if (raw) {
      const content = gists.get(raw[1]!)?.files[decodeURIComponent(raw[2]!)];
      if (content === undefined) return send(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': raw[2]!.endsWith('.svg') ? 'image/svg+xml' : 'text/plain' });
      return res.end(content);
    }
    send(res, 404, { message: 'Not Found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    gists,
    approve: () => {
      approved = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: Write the E2E test** — `packages/cli/test/e2e-publish.test.ts`. Use the Claude Code fixture setup from `sync.test.ts` (point `CLAUDE_CONFIG_DIR` at a temp dir with one JSONL transcript containing two assistant messages on different days). Scenario:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLogin } from '../src/commands/login.js';
import { runReadme } from '../src/commands/readme.js';
import { runSync } from '../src/commands/sync.js';
import { readConfig } from '../src/config.js';
import { pollForToken } from '../src/github/device-flow.js';
import { startFakeGitHub } from './fake-github.js';

let github: Awaited<ReturnType<typeof startFakeGitHub>>;

beforeAll(async () => {
  github = await startFakeGitHub();
  process.env['TOKENGRAPH_GITHUB_API'] = github.url;
  process.env['TOKENGRAPH_GITHUB_WEB'] = github.url;
  // + fixture transcripts as in sync.test.ts
});
afterAll(async () => {
  delete process.env['TOKENGRAPH_GITHUB_API'];
  delete process.env['TOKENGRAPH_GITHUB_WEB'];
  await github.close();
});

describe('login → sync → readme, end to end', () => {
  it('publishes a graph a README can show', async () => {
    const code = await runLogin(
      { method: 'device', openBrowser: false },
      {
        isTTY: false,
        copy: async () => false,
        pollForToken: (deviceCode) => {
          github.approve();
          return pollForToken(deviceCode, { sleep: async () => undefined });
        },
        firstPublish: () => runSync({ sinceDays: 400, theme: 'light', quiet: true }),
        offerSchedule: async () => undefined,
      },
    );
    expect(code).toBe(0);
    const config = await readConfig();
    const graph = github.gists.get(config.gists!.graph!)!;
    expect(graph.public).toBe(true);
    expect(graph.files['tokengraph-light.svg']).toMatch(/^<svg/);
    const response = await fetch(`${github.url}/raw/${graph.id}/tokengraph-dark.svg`);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    const data = github.gists.get(config.gists!.data!)!;
    expect(data.public).toBe(false);
    expect(Object.keys(data.files).some((name) => name.startsWith('machine-'))).toBe(true);
    expect(await runReadme({ compact: false, copy: async () => true })).toBe(0);
  });

  it('a deleted graph gist comes back on the next sync', async () => {
    const before = (await readConfig()).gists!.graph!;
    github.gists.delete(before);
    expect(await runSync({ sinceDays: 30, theme: 'light', quiet: true })).toBe(0);
    const after = (await readConfig()).gists!.graph!;
    expect(after).not.toBe(before);
    expect(github.gists.has(after)).toBe(true);
  });

  it('a second machine (fresh home, new fingerprint) adds up instead of replacing', async () => {
    // Switch TOKENGRAPH_HOME to a new temp dir, write a config with the same github login and token
    // ({ github: { login: 'octocat', auth: { kind: 'token', token: 'gho_fake' } } }), run runSync with
    // deps.fingerprint returning 'fp-second' and a different fixture transcript; then assert the data gist
    // holds two machine files and the graph SVG changed. Restore TOKENGRAPH_HOME afterwards.
  });
});
```
Write the third test fully (the comment describes it; replace it with the code), using `mkdtemp` for the second home and `writeConfig` to seed it.

- [ ] **Step 3: Run** `npx vitest run packages/cli/test/e2e-publish.test.ts` → PASS; then the full suite and `npx tsc --build`.

- [ ] **Step 4: Bundle smoke check**

```bash
cd packages/cli && npm run build && cd ../..
TOKENGRAPH_HOME=$(mktemp -d) node packages/cli/bundle/bin.js --help
TOKENGRAPH_HOME=$(mktemp -d) node packages/cli/bundle/bin.js login --help
TOKENGRAPH_HOME=$(mktemp -d) node packages/cli/bundle/bin.js sync --local --since 7
```
Expected: help lists `login`, `logout`, `sync`, `readme`, `status`, `install-hook`, `schedule`, `view`; no `uploads`. `sync --local` exits 0.

- [ ] **Step 5: Commit** (`Test login, sync and readme end to end against a fake GitHub`).
