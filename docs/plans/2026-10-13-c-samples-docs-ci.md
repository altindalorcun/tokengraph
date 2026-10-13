# Plan C: samples for the site, a README that earns stars, docs and CI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public repo ready to be starred and published: one script that generates every sample image and the site's data, a README that sells the product in ten seconds, contributor docs, and CI + release workflows.

**Architecture:** `scripts/samples.mjs` imports the built packages (`packages/core/dist`, `packages/cli/dist`) and writes the samples contract from the spec into any folder (the site's `public/samples/`, and `docs/assets/` for the README). The README is the root `README.md`; `scripts/sync-readme.mjs` copies it to `packages/cli/README.md` with absolute image URLs for npm. CI runs on GitHub Actions (free for public repos).

**Tech Stack:** Node ≥ 22 ESM scripts, React `createElement` (no JSX in `.mjs`), the Plan B renderer, GitHub Actions.

**Spec:** `docs/specs/2026-10-13-local-first-design.md` (sections "Samples contract", "Public repo hygiene").

**Prerequisite:** Plans A and B are complete.

## Global Constraints

- Workspace root: `/Users/orcunaltindal/codes/tokengraph/cli`. The archived repo `/Users/orcunaltindal/codes/token-graph` is read-only.
- Samples are reproducible: fixed reference date `2026-10-11T12:00:00Z`, demo account `octocat` (`DEMO_HANDLE`), the core `demoUsage`/`demoStory`. Running the script twice yields byte-identical files.
- Samples contract file names: `graph-dark.svg`, `graph-light.svg`, `graph-compact-dark.svg`, `graph-compact-light.svg`, `story-skyline.png`, `story-receipt.png`, `story-sticker.png`, `story-strip.png`, `og.png` (1200×630), `qr-repo.svg` (a scannable QR of the project URL, black on white, quiet zone 4, `shape-rendering="crispEdges"`, built from `qrMatrix` in `packages/cli/dist/share/qr.js`), `landing.json` (schema 1, below).
- Project URL `https://github.com/altindalorcun/tokengraph`; npm package `tokengraph`; install line `npx tokengraph`.
- Nothing in this repo may mention the private site repo's internals, `apps/web`, Supabase, `DATABASE_URL`, `AUTH_SECRET`, or any secret.
- English for everything in this repo. Voice: plain, concrete, no hype words ("revolutionary", "seamless", "supercharge"), no emoji walls.
- Commit after every task; last line exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- The README's snippet and commands must match what the CLI really prints and accepts (`tokengraph --help`, `tokengraph readme`); a reader copying them must succeed (Task 2: the implementer runs each command in a temp home).
- `npm pack` must ship `README.md`, `LICENSE`, `bundle/bin.js`, `assets/**`, and nothing else (Task 4 `check-pack.mjs`).
- Images in the npm README must be absolute URLs, or npm shows broken images (Task 2 test of `sync-readme.mjs`).
- `landing.json` must carry everything the site needs to draw the hero graph without importing core: grid, palette CSS, logos, labels (Task 1 asserts the keys).
- CI on Windows: path and line-ending differences can fail tests that pass on macOS; the workflow must surface them, not hide them (Task 4 runs Windows without `continue-on-error`).

---

### Task 1: The samples script

**Files:**
- Create: `scripts/samples.mjs`, `scripts/samples-landing.mjs` (pure builders of `landing.json`, importable by a test), `packages/cli/test/samples-landing.test.ts`
- Create (generated, committed): `docs/assets/graph-dark.svg`, `docs/assets/graph-light.svg`, `docs/assets/story-strip.png`, `docs/assets/og.png`
- Modify: root `package.json` (`"samples": "npm run build -w tokengraph && node scripts/samples.mjs"`)

**Interfaces:**
- Consumes (from built dist): core `demoUsage`, `demoStory`, `DEMO_HANDLE`, `renderPublishedGraphs`, `buildGraphGrid`, `toGraphDaysByFamily`, `FAMILY_RAMPS`, `FAMILY_RAMPS_LIGHT`, `GRAPH_RAMP_DARK`, `GRAPH_RAMP_LIGHT`, `NEUTRAL_RAMP_DARK`, `NEUTRAL_RAMP_LIGHT`, `DISPLAY_SURFACES`, `MODEL_FAMILIES`, `FAMILY_LABELS`, `FAMILY_LOGOS`, `AGENT_LOGOS`, `brandPaint`, `modelFamily`, `logoLockupSvg`, `svgUri`, `KNOWN_SOURCES`, `STORY_TEMPLATES`, `STORY_SIZES`; cli `createStoryRenderer` (`packages/cli/dist/story/render.js`), `STORY_CTA`.
- Produces `landing.json`:

```ts
interface LandingSamples {
  schema: 1;
  referenceDate: string;                 // '2026-10-11'
  handle: string;                        // 'octocat'
  grid: GraphGrid;                       // buildGraphGrid(familyDays, referenceDate), JSON as is
  stats: { total: number; activeDays: number; streak: number; best: { date: string; weighted: number } | null };
  families: { family: string; label: string; weighted: number; share: number }[];   // heaviest first
  recentBars: { date: string; weighted: number; family: string | null }[];        // last 14 days
  dayModels: Record<string, { label: string; family: string; weighted: number; share: number }[]>; // per date, top 4
  paletteCss: string;                    // the --graph-* custom properties, light default + dark via prefers-color-scheme and [data-theme]
  logos: { families: Record<string, string>; agents: Record<string, { label: string; svg: string }> };  // inline SVG markup
}
```

- [ ] **Step 1: Write the pure builders** — `scripts/samples-landing.mjs` exports `buildLanding(core, { referenceDate, handle })` returning the object above. Port the logic, not the imports, from:
  - `familyShares` and `recentBars` in `/Users/orcunaltindal/codes/token-graph/apps/web/lib/landing-visuals.ts`;
  - `declarations` / `graphThemeCss` in `/Users/orcunaltindal/codes/token-graph/apps/web/lib/graph-css.ts` → `paletteCss` (same variable names: `--graph-single-<level>`, `--graph-neutral-<level>`, `--graph-<family>-<level>`, level 0 = the surface's `empty`);
  - `summarizeStats` streak (core story exports it after Plan B Task 1; if not exported, compute the streak as consecutive days with usage ending at the reference date);
  - `dayModels`: per date, models summed, labelled with core `modelLabel`, top 4 by weight, share of the day.
  - Agent logos: for each source in `KNOWN_SOURCES` with art in `AGENT_LOGOS`, build the inline SVG the way the archived web app's `app/components/agent-logo.tsx` does (read it for the exact markup) and pair it with a human label (`Claude Code`, `Codex CLI`, `Cursor`, `Gemini CLI`, `Cline`, `OpenCode`). Family logos likewise from `FAMILY_LOGOS` (see `app/components/model-logo.tsx`).
  `core` is passed in (the module namespace), so the test can pass the source modules.

- [ ] **Step 2: Test the builder** — `packages/cli/test/samples-landing.test.ts`:

```ts
import * as core from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without types
import { buildLanding } from '../../../scripts/samples-landing.mjs';

describe('landing.json', () => {
  const landing = buildLanding(core, { referenceDate: '2026-10-11', handle: 'octocat' });

  it('has every key the site reads', () => {
    expect(Object.keys(landing).sort()).toEqual(
      ['dayModels', 'families', 'grid', 'handle', 'logos', 'paletteCss', 'recentBars', 'referenceDate', 'schema', 'stats'].sort(),
    );
    expect(landing.schema).toBe(1);
    expect(landing.grid.columns).toHaveLength(core.WEEKS);
    expect(landing.recentBars).toHaveLength(14);
    expect(landing.paletteCss).toContain('--graph-claude-4:');
    expect(landing.paletteCss).toContain('prefers-color-scheme:dark');
    expect(Object.keys(landing.logos.agents)).toContain('claude-code');
  });

  it('agrees with the graph: total equals the grid total, shares sum to 1', () => {
    expect(landing.stats.total).toBe(landing.grid.total);
    expect(landing.families.reduce((sum: number, f: { share: number }) => sum + f.share, 0)).toBeCloseTo(1, 6);
  });

  it('is reproducible', () => {
    expect(JSON.stringify(buildLanding(core, { referenceDate: '2026-10-11', handle: 'octocat' }))).toBe(JSON.stringify(landing));
  });
});
```
Run: `npx vitest run packages/cli/test/samples-landing.test.ts` → PASS (write the test first, see it fail on the missing module, then write Step 1's code).

- [ ] **Step 3: Write `scripts/samples.mjs`**

```js
#!/usr/bin/env node
// Writes every sample the site and the README show, from the demo account on a fixed day:
//   node scripts/samples.mjs <outDir> [--readme]
// --readme also refreshes docs/assets/ (graph-dark.svg, graph-light.svg, story-strip.png, og.png).
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement as h } from 'react';
import * as core from '../packages/core/dist/index.js';
import { createStoryRenderer } from '../packages/cli/dist/story/render.js';
import { STORY_CTA } from '../packages/cli/dist/story/cards/context.js';
import { buildLanding } from './samples-landing.mjs';

const REFERENCE = new Date('2026-10-11T12:00:00Z');
const REFERENCE_DATE = '2026-10-11';
const out = resolve(process.argv[2] ?? 'samples');
const readme = process.argv.includes('--readme');
mkdirSync(out, { recursive: true });

// 1. README graphs, exactly as `tokengraph sync` publishes them.
const { modelRows } = core.demoUsage(REFERENCE);
const usage = modelRows.map((row) => ({
  date: row.date,
  model: row.model,
  pricingTier: 'standard',
  counts: { ...row, cacheCreation5mTokens: null, cacheCreation1hTokens: null },
}));
const graphs = core.renderPublishedGraphs(usage, { today: REFERENCE_DATE, colors: 'model' });
const graphFiles = {
  'graph-dark.svg': graphs['tokengraph-dark.svg'],
  'graph-light.svg': graphs['tokengraph-light.svg'],
  'graph-compact-dark.svg': graphs['tokengraph-compact-dark.svg'],
  'graph-compact-light.svg': graphs['tokengraph-compact-light.svg'],
};
for (const [name, svg] of Object.entries(graphFiles)) writeFileSync(join(out, name), svg);

// 2. Story cards at half size (they are shown at most ~400px wide) and a side-by-side strip.
const renderer = await createStoryRenderer();
const data = core.demoStory('today', REFERENCE);
const cards = [];
for (const template of core.STORY_TEMPLATES) {
  const png = await renderer.render(template, { data, showCost: true, cta: STORY_CTA }, 0.5);
  writeFileSync(join(out, `story-${template}.png`), png);
  cards.push({ template, png });
}
const THUMB = 360;
const GAP = 32;
const thumbs = cards.map(({ template, png }) => ({
  template,
  src: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
  height: Math.round((core.STORY_SIZES[template].height / core.STORY_SIZES[template].width) * THUMB),
}));
const stripWidth = thumbs.length * THUMB + (thumbs.length - 1) * GAP;
const stripHeight = Math.max(...thumbs.map((t) => t.height));
const strip = h(
  'div',
  { style: { display: 'flex', flexDirection: 'row', alignItems: 'flex-start', width: stripWidth, height: stripHeight } },
  ...thumbs.map((t, i) => h('img', { key: t.template, src: t.src, width: THUMB, height: t.height, style: { marginLeft: i === 0 ? 0 : GAP, borderRadius: 24 } })),
);
writeFileSync(join(out, 'story-strip.png'), (await renderer.rasterize(strip, { width: stripWidth, height: stripHeight }, stripWidth)).png);

// 3. The social preview: logo, headline, the real graph, the install line.
const og = h(
  'div',
  { style: { display: 'flex', flexDirection: 'column', width: 1200, height: 630, background: '#0b0b0d', padding: '56px 64px', justifyContent: 'space-between' } },
  h('img', { src: core.svgUri(core.logoLockupSvg('dark')), height: 44, width: 170 }),
  h('div', { style: { display: 'flex', fontFamily: 'Plex Sans', fontWeight: 600, fontSize: 60, color: '#f4f4f5', letterSpacing: -1 } }, 'Your AI coding, as a GitHub-style graph.'),
  h('img', { src: core.svgUri(graphs['tokengraph-compact-dark.svg']), width: 1072, height: 200 }),
  h('div', { style: { display: 'flex', fontFamily: 'Plex Mono', fontSize: 30, color: '#a1a1aa' } }, STORY_CTA),
);
writeFileSync(join(out, 'og.png'), (await renderer.rasterize(og, { width: 1200, height: 630 }, 1200)).png);

// 4. A QR that opens the repo, for the site's story section (scanning the demo leads somewhere real).
const { qrMatrix } = await import('../packages/cli/dist/share/qr.js');
const matrix = qrMatrix('https://github.com/altindalorcun/tokengraph');
const size = matrix.length + 8;
const modules = matrix.flatMap((row, y) => row.map((dark, x) => (dark ? `<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>` : ''))).join('');
writeFileSync(join(out, 'qr-repo.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${modules}</g></svg>\n`);

// 5. Everything the landing page draws itself.
writeFileSync(join(out, 'landing.json'), `${JSON.stringify(buildLanding(core, { referenceDate: REFERENCE_DATE, handle: core.DEMO_HANDLE }), null, 2)}\n`);

if (readme) {
  const assets = resolve('docs/assets');
  mkdirSync(assets, { recursive: true });
  for (const name of ['graph-dark.svg', 'graph-light.svg', 'story-strip.png', 'og.png']) copyFileSync(join(out, name), join(assets, name));
}
console.log(`samples written to ${out}${readme ? ' (and docs/assets)' : ''}`);
```
Fix sizes so nothing is distorted: read the compact SVG's `width`/`height` attributes and scale the `img` to 1072px wide keeping its aspect ratio; the logo lockup aspect is in core (`LOGO_LOCKUP_VIEWBOX` 189.82×49.36). If `react` is not resolvable from `scripts/`, it is a devDependency of `packages/cli`; install it at the root as a devDependency too.

- [ ] **Step 4: Run it twice and look at the output**

```bash
npm run samples -- /tmp/tg-samples-a --readme
node scripts/samples.mjs /tmp/tg-samples-b
diff -r /tmp/tg-samples-a /tmp/tg-samples-b && echo reproducible
```
Expected: `reproducible`. Open `/tmp/tg-samples-a/og.png`, `story-strip.png` and both graph SVGs with the Read tool and confirm they look right (no overflow, nothing cut, readable text). Record what you checked.

- [ ] **Step 5: Commit** the scripts, the test, `docs/assets/*` and `package.json` (`Generate the site and README samples from the demo account`).

---

### Task 2: The README

**Files:**
- Rewrite: `README.md`
- Create: `scripts/sync-readme.mjs`, `packages/cli/test/sync-readme.test.ts`
- Modify: `packages/cli/package.json` (`"prepack": "node ../../scripts/sync-readme.mjs && npm run build"`), `packages/cli/src/commands/login-finish.ts` (star line)

**Interfaces:**
- Produces: `export function npmReadme(markdown: string, repoRawBase: string): string` in `scripts/sync-readme.mjs` (rewrites `](docs/...)`, `src="docs/...`, `srcset="docs/...` to `https://raw.githubusercontent.com/altindalorcun/tokengraph/main/docs/...`), and running the script writes `packages/cli/README.md`.

- [ ] **Step 1: Test the npm README rewrite** — `packages/cli/test/sync-readme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without types
import { npmReadme } from '../../../scripts/sync-readme.mjs';

const RAW = 'https://raw.githubusercontent.com/altindalorcun/tokengraph/main/';

describe('npmReadme', () => {
  it('makes repo-relative images absolute and leaves everything else alone', () => {
    const input = [
      '![graph](docs/assets/graph-light.svg)',
      '<source srcset="docs/assets/graph-dark.svg">',
      '<img src="docs/assets/graph-light.svg">',
      '[docs](https://example.com/docs/x)',
      'See `docs/product.md`.',
    ].join('\n');
    expect(npmReadme(input, RAW)).toBe(
      [
        `![graph](${RAW}docs/assets/graph-light.svg)`,
        `<source srcset="${RAW}docs/assets/graph-dark.svg">`,
        `<img src="${RAW}docs/assets/graph-light.svg">`,
        '[docs](https://example.com/docs/x)',
        'See `docs/product.md`.',
      ].join('\n'),
    );
  });
});
```
Then implement `scripts/sync-readme.mjs` (export `npmReadme`; when run directly — `import.meta.url === pathToFileURL(process.argv[1]).href` — read root `README.md` and write `packages/cli/README.md`).

- [ ] **Step 2: Write `README.md`.** Structure (all of it, in this order):

1. Centered header: `<picture>` with the logo lockup (write `docs/assets/logo-dark.svg` and `docs/assets/logo-light.svg` from core `logoLockupSvg('dark'|'light')` in Task 1's script if you need them — add them to the `--readme` copy list), then one line: **Your AI coding, as a GitHub-style graph.** Then: *Claude Code, Codex CLI, Cursor, Gemini CLI, Cline and OpenCode — one graph, in your README. Your usage never leaves your machine unless you publish it, and then only to your own gist.* Badges: npm version (`https://img.shields.io/npm/v/tokengraph`), license, CI (workflow `ci.yml`).
2. The hero graph with `<picture>` (`docs/assets/graph-dark.svg` / `graph-light.svg`).
3. **Quick start** — three lines in one code block with comments:
   ```bash
   npx tokengraph            # your graph, right in the terminal
   npx tokengraph login      # publish it to your GitHub gist and get the README snippet
   npx tokengraph story      # turn today into story cards and send them to your phone
   ```
   followed by: "To keep the README graph fresh: `npm install -g tokengraph && tokengraph schedule`."
4. **Put it in your README** — what `tokengraph readme` prints (copy the real output format from `readmeSnippet`, with `YOUR_LOGIN/GIST_ID` placeholders), one sentence on light/dark switching, one on `--compact` and `--colors single`.
5. **Share your day** — `docs/assets/story-strip.png`, then: "`tokengraph story` draws three cards… shows a QR code; scan it with your phone on the same Wi-Fi and save them straight to Photos. Nothing is uploaded anywhere."
6. **How it works** — a small fenced diagram:
   ```
   agent logs on your machine ──► tokengraph ──► ~/.tokengraph ledger ──► your gists
   (Claude Code, Codex, …)        dedups,         (totals only grow)       public: the SVG graph
                                   weights                                  secret: daily counts per machine
   ```
   plus the weighted-token formula and one sentence each on dedup and "totals only grow".
7. **Privacy** — a short table: *What leaves your machine* (SVG graph → your public gist; per-day, per-model token counts → your secret gist; only after `tokengraph login`) / *What never does* (prompts, code, file names, paths, anything to a tokengraph server — there is none) / *How to remove it* (`tokengraph logout`, delete the gists).
8. **Supported agents** — a table: agent, where it reads, notes (copy from `CLAUDE.md`'s adapter list; Cursor needs `tokengraph install-hook --agent cursor`).
9. **Commands** — a table of every public command with one line each (match `tokengraph --help`).
10. **Several machines** — one paragraph (secret data gist, each machine its own file, summed; a reinstall gets its history back).
11. **FAQ** — Why gists? (free, yours, cached by GitHub, no server to trust or shut down) · Is the cost real? (estimate at public API prices; unknown models stay unknown) · Why "weighted" tokens? · Does it work offline? · How do I stop? · Windows?
12. **Contributing** — link `CONTRIBUTING.md`; "New agents arrive as adapter PRs."
13. Closing line: "If tokengraph made your profile better, a ⭐ helps other people find it." and **License**: MIT.

Check every command and flag against `node packages/cli/dist/bin.js <command> --help` before committing; run `npx tokengraph`-equivalents with `node packages/cli/dist/bin.js` in a temp `TOKENGRAPH_HOME` for `view --print`, `sync --local`, `story --no-qr --out /tmp/x`.

- [ ] **Step 3: Star line after the first publish.** In `packages/cli/src/commands/login-finish.ts`, after `runReadme` succeeds in `firstPublish`, print:
  `\nIf you like it, a ⭐ on GitHub helps other people find it: https://github.com/altindalorcun/tokengraph`
  (once per login; no state needed). Use `PROJECT_URL` from `readme-snippet.ts`.

- [ ] **Step 4: Run** `node scripts/sync-readme.mjs && npx vitest run packages/cli/test/sync-readme.test.ts && npx tsc --build && npx vitest run`. **Step 5: Commit** (`Write the README and ship it to npm with absolute image links`).

---

### Task 3: Product and contributor docs

**Files:**
- Rewrite: `docs/product.md`
- Create: `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/new_agent.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/pull_request_template.md`
- Copy: `docs/agents/{claude-code?,codex,cursor,gemini-cli,cline,opencode,aider}-usage.md` from `/Users/orcunaltindal/codes/token-graph/docs/*-usage.md`; `docs/specs/2026-10-11-story-cards-design.md` from `/Users/orcunaltindal/codes/token-graph/docs/superpowers/specs/`
- Modify: `CLAUDE.md` (point the OpenCode rule at `docs/agents/opencode-usage.md`)

- [ ] **Step 1: `docs/product.md`** — write it with these sections and this substance:
  - *What it is*: the graph, the terminal view, story cards; local-first; no server.
  - *Who it's for*: anyone coding with AI agents; a tool is supported only when its usage can be read reliably from local data.
  - *What success looks like*: 1. people put the graph in their README; 2. people share story cards; 3. GitHub stars and adapter contributions. "None of this counts if the numbers are wrong" — accuracy rules (totals only grow, every adapter dedups the way its tool writes logs and is checked against an independent count, unknown is shown as unknown).
  - *Principles*: tool-neutral; open source (MIT), everything in this repo; local-first and free to run (nothing the project pays for scales with users); token counts only; publishing is opt-in and goes to the user's own GitHub account.
  - *Non-goals*: a hosted service or accounts; billing or spend tracking; collecting prompts or code; leaderboards or comparing people (a community wall built from PRs may come later); team dashboards.
  - *Ideas for later*: a PR-based community wall, a public profile page rendered from a gist, Homebrew.
- [ ] **Step 2: Copy the agent docs and the story-cards spec.** After copying, remove or rewrite every sentence that mentions the hosted server, uploads to "the server", `apps/web`, Supabase or the dashboard: these docs describe how each agent writes its local logs, which stays true. `grep -rniE "apps/web|supabase|server|dashboard|upload" docs/agents docs/specs/2026-10-11-story-cards-design.md` must print only lines you checked and kept on purpose (e.g. an agent's own "server" concept); list them in your report.
- [ ] **Step 3: `CONTRIBUTING.md`** — setup (`npm install`, `npx tsc --build`, `npx vitest run`), project layout (core vs cli boundary), **adding an agent** step by step: (1) document the agent's local log format in `docs/agents/<agent>-usage.md` with real (redacted) samples; (2) add the source to `KNOWN_SOURCES`; (3) write `packages/cli/src/adapters/<agent>/` following an existing adapter (dedup key, model id canonicalisation via `canonicalModelId`, pricing tier); (4) fixtures and tests under `packages/cli/test/`; (5) check totals against an independent count and say how in the PR; (6) never count usage another adapter already counts. Then: the invariants list (link `CLAUDE.md`), commit style, "tests never touch your real `~/.tokengraph` or GitHub".
- [ ] **Step 4: `SECURITY.md`** — report privately through GitHub's "Report a vulnerability" (private advisories); what is in scope (token storage in `~/.tokengraph/config.json`, the gist publishing, the QR share server); response expectations (best effort, volunteer project).
- [ ] **Step 5: Issue and PR templates** — `bug_report.yml` (version from `tokengraph --version`, OS, agents used, `tokengraph status` output with gist URLs redacted if they wish, what happened); `new_agent.yml` (agent name, where it stores usage locally, sample record with secrets removed); `config.yml` (`blank_issues_enabled: false`); PR template (what changed, how it was checked, for adapters the independent count).
- [ ] **Step 6: Leak scan** — `grep -rniE "apps/web|supabase|DATABASE_URL|AUTH_SECRET|AUTH_GITHUB|token-graph\.dev|tokengraph\.dev" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.superpowers .` must print nothing except deliberate mentions you justify in the report (the pre-release `token-graph` CLI name in migration code is fine). **Step 7: Commit** (`Add product, contributor and security docs`).

---

### Task 4: CI, release workflow and the package check

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/check-pack.mjs`
- Modify: root `package.json` (`"check:pack": "node scripts/check-pack.mjs"`)

- [ ] **Step 1: `scripts/check-pack.mjs`**

```js
// Fails when the npm tarball ships anything unexpected or grows past the budget.
import { execFileSync } from 'node:child_process';

const MAX_UNPACKED = 6_000_000;
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '-w', 'tokengraph'], { encoding: 'utf8', shell: process.platform === 'win32' }));
const files = pack.files.map((file) => file.path).sort();
const allowed = (path) => ['package.json', 'README.md', 'LICENSE', 'bundle/bin.js'].includes(path) || path.startsWith('assets/');
const unexpected = files.filter((path) => !allowed(path));
const missing = ['package.json', 'README.md', 'LICENSE', 'bundle/bin.js', 'assets/resvg.wasm'].filter((path) => !files.includes(path));
const problems = [];
if (unexpected.length) problems.push(`unexpected files: ${unexpected.join(', ')}`);
if (missing.length) problems.push(`missing files: ${missing.join(', ')}`);
if (pack.unpackedSize > MAX_UNPACKED) problems.push(`unpacked size ${pack.unpackedSize} > ${MAX_UNPACKED}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`pack ok: ${files.length} files, ${(pack.unpackedSize / 1e6).toFixed(2)} MB unpacked`);
```
Run `npm run check:pack` → `pack ok`. Also confirm `packages/cli/package.json` has no `dependencies` key.

- [ ] **Step 2: `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npx tsc --build
      - run: npx vitest run
      - run: npm run smoke
      - run: npm run check:pack
```

- [ ] **Step 3: `.github/workflows/release.yml`** (publishes when the owner pushes a `v*` tag; needs the `NPM_TOKEN` repository secret):

```yaml
name: Release
on:
  push:
    tags: ['v*']

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npx tsc --build && npx vitest run
      - name: Tag matches the package version
        run: test "v$(node -p "require('./packages/cli/package.json').version")" = "$GITHUB_REF_NAME"
      - run: npm publish -w tokengraph --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

- [ ] **Step 4: Validate the YAML locally** — `node -e "for (const f of ['ci','release']) { const t = require('fs').readFileSync('.github/workflows/'+f+'.yml','utf8'); if (/\t/.test(t)) throw new Error(f+' has tabs'); } console.log('yaml ok')"`; if `npx --yes yaml-lint` or `actionlint` is available, run it too and record the result.
- [ ] **Step 5: Commit** (`Add CI, the release workflow and the package check`).
