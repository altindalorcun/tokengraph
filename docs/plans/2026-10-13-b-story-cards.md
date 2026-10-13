# Plan B: story cards in the CLI, terminal preview, QR hand-off to the phone

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tokengraph story` renders the three Instagram/TikTok story cards from local data, previews them in the terminal, saves them, and hands them to the phone through a QR code and a one-off local web page.

**Architecture:** The pure story data (`buildStory` and the dashboard helpers it needs, the logo, the demo account) moves from the archived web app into `packages/core/src/story/`. The cards (JSX), the Satori + resvg-wasm pipeline, the asset loader, the terminal image encoders, the QR renderer and the share server live in `packages/cli/src/story/` and `packages/cli/src/share/`. Fonts and `resvg.wasm` ship in `packages/cli/assets/`.

**Tech Stack:** TypeScript, React 19 JSX (automatic runtime, only for building Satori element trees), `satori@0.25.0`, `@resvg/resvg-wasm@2.6.2`, `qrcode-generator@2.0.4` (MIT), `jsqr@1.4.0` (tests only), `node:http`, `node:os`, esbuild.

**Spec:** `docs/specs/2026-10-13-local-first-design.md` (sections "Story cards in the CLI", "QR hand-off").

**Prerequisite:** Plan A is complete (config with `github.login`, `combinedUsage`, `readMachinesCache`, `askYesNo`, `revealInFileManager`, `bin-path.ts`).

## Global Constraints

- Workspace root: `/Users/orcunaltindal/codes/tokengraph/cli`. Source of the code being ported: `/Users/orcunaltindal/codes/token-graph/apps/web` (read-only; never modify that repo).
- `packages/core` stays free of third-party imports and of file/network I/O; JSX, Satori, resvg, sockets and `fs` live in `packages/cli`.
- `satori`, `@resvg/resvg-wasm`, `react`, `qrcode-generator` are **devDependencies** of `packages/cli` (inlined into `bundle/bin.js` by esbuild). `packages/cli` keeps zero runtime `dependencies`.
- Assets: `packages/cli/assets/resvg.wasm`, `packages/cli/assets/fonts/*.ttf` (the seven IBM Plex files from `apps/web/public/story/fonts`), `packages/cli/assets/fonts/OFL.txt`. Located only through `assetsDir()` in `bin-path.ts`.
- Card sizes: skyline and receipt 1080×1920, sticker 1080×1380. Safe zone y=250..1670 for full-bleed cards (see `docs/superpowers/specs/2026-10-11-story-cards-design.md` in the archived repo for Satori rules: flex only, no `inset`, no CSS gradients or blur — use `backdropSvg`).
- Card call to action: `npx tokengraph`. A card names the person as `@<handle>`; it never prints a `/u/<handle>` URL (there are no profile pages any more).
- Default output folder: `~/Downloads` when it exists, else the home folder. File names from `storyFileName`.
- Share server: binds one private IPv4 (10/8, 172.16/12, 192.168/16) only, random port, every URL under a 128-bit random token (base64url, 22 chars), GET/HEAD only, PNGs served from memory, stops on Ctrl+C, 30 s after every card was saved, or 10 minutes idle.
- QR: ECC level M, quiet zone 4 modules, forced black on white with 256-colour escapes (`\x1b[38;5;16m` / `\x1b[48;5;231m`), half-block characters.
- The phone page is one self-contained HTML document: inline CSS and script, no external requests.
- Tests never write to the real `~/Downloads` or `~/.tokengraph`, and never open a real listening socket on a LAN address (use `127.0.0.1` in tests).
- Commit after every task; last line exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A machine with no usage in the chosen range: `story` must still render cards (the cards' own empty state) and not crash on empty arrays (Task 3 test).
- No LAN address (offline laptop, VPN only): `story` says so, keeps the saved files, exits 0 (Task 7 test).
- The phone opens the page but saves by long-press (no request reaches the server): the server must not wait forever — the 10-minute idle timer ends it (Task 6 test with fake timers).
- A terminal without image support and without truecolor (Apple Terminal): the preview falls back to 256-colour half blocks, never prints raw escape garbage (Task 4 test on `detectImageProtocol` + `halfBlockImage` 256 mode).
- `story` run from the npx bundle: assets must resolve next to `bundle/bin.js` (Task 8 smoke test runs the bundle).

---

### Task 1: Move story data into core

**Files:**
- Create in `packages/core/src/story/`: `aggregate.ts`, `cost.ts`, `range.ts`, `stats.ts`, `model-colors.ts`, `data.ts`, `format.ts`, `color.ts`, `skyline.ts`, `art.ts`, `options.ts`, `demo.ts`, `demo-usage.ts`, `logo.ts`, `index.ts`
- Modify: `packages/core/src/index.ts`
- Create tests in `packages/core/test/story/`: ported from `apps/web/test/{dashboard-aggregate,dashboard-cost,dashboard-range,dashboard-stats,story-data,demo-usage,logo}.test.ts`

**Interfaces:**
- Consumes: from core root — `ModelDayRow`, `FamilyGraphDay`, `toGraphDaysByFamily`, `graphEndDate` (Plan A Task 3), pricing, families, logos.
- Produces (exported from `@tokengraph/core`):

```ts
export type StoryTemplate = 'skyline' | 'receipt' | 'sticker';
export const STORY_TEMPLATES: readonly StoryTemplate[];
export type StoryRange = 'today' | '7d' | '30d' | '1y';
export const STORY_RANGES: readonly StoryRange[];
export const STORY_SIZES: Record<StoryTemplate, { width: number; height: number }>;
export interface StoryOptions { template: StoryTemplate; range: StoryRange; showCost: boolean }
export function storyFileName(handle: string, endDate: string, options: StoryOptions): string;
export interface ModelDayTotals extends ModelDayRow {}          // same shape as the web's
export interface CostRow { date; model; pricingTier; inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens; cacheCreation5mTokens: number | null; cacheCreation1hTokens: number | null }
export interface StoryData { /* exactly as apps/web/lib/story/data.ts */ }
export interface StoryInput { handle: string; range: StoryRange; todayUtc: string; rows: readonly ModelDayTotals[]; costRows: readonly CostRow[]; demo?: boolean }
export function buildStory(input: StoryInput): StoryData;
export function demoStory(range: StoryRange, now: Date): StoryData;
export function demoUsage(now: Date): { days: FamilyGraphDay[]; modelRows: ModelDayRow[]; endDate: string; /* + what the web version returns that the CLI needs */ };
export const DEMO_HANDLE = 'octocat';
export function logoLockupSvg(theme: 'light' | 'dark'): string;
export function svgUri(svg: string): string;
export function backdropSvg(...): string;                      // from art.ts
```

- [ ] **Step 1: Copy the files**

```bash
WEB=/Users/orcunaltindal/codes/token-graph/apps/web
D=packages/core/src/story && mkdir -p $D packages/core/test/story
cp $WEB/lib/dashboard/{aggregate,cost,range,stats}.ts $D/
cp $WEB/lib/dashboard/models.ts $D/model-colors.ts
cp $WEB/lib/story/{data,format,color,skyline,art,options,demo}.ts $D/
cp $WEB/lib/demo-usage.ts $D/demo-usage.ts
cp $WEB/lib/logo.ts $D/logo.ts
for t in dashboard-aggregate dashboard-cost dashboard-range dashboard-stats story-data demo-usage logo; do cp $WEB/test/$t.test.ts packages/core/test/story/$t.test.ts; done
```

- [ ] **Step 2: Rewrite imports and trim to what the story needs**

Rules, applied to every copied file:
- `@token-graph/core` → the relative core module (`../tokens.js`, `../pricing.js`, `../model-makers.js`, `../graph-days.js`, `../dates.js`, …) — never import `../index.js` from inside core.
- `@/lib/dashboard/<x>` → `./<x>.js` (`models` → `./model-colors.js`); `@/lib/graph-days` → `../graph-days.js`; `@/lib/graph-models` (only `ModelDayRow`) → `../graph-days.js`; `@/lib/model-makers` → `../model-makers.js` (move `displayModelName` from `apps/web/lib/model-makers.ts` into `packages/core/src/model-makers.ts` if a copied file uses it); `@/lib/demo-usage` → `./demo-usage.js`; `@/lib/sample-graph` (`seededRandom`) → copy that one function into `demo-usage.ts`; `@/lib/logo` → `./logo.js`.
- Add `.js` suffixes to every relative import (NodeNext).
- `options.ts`: drop `RANGE_LABELS` import from range by defining `STORY_RANGE_LABELS` literally (`today: 'Today'`, `'7d': '7 days'`, `'30d': '30 days'`, `'1y': '12 months'` — copy the exact strings from `apps/web/lib/dashboard/range.ts`); delete `parseStoryOptions` and `sampleStoryPath` (web-only).
- Delete functions no story code, no copied test and no CLI need uses (e.g. `modelOptions`, `parseModelFilter`, `resolveModelFilter`, `filterByModel`, `formatDelta`, `parseRange`, `querySinceDate`, `dayModelDetails` usage in demo-usage if only the web used it). Run `npx tsc --build` and the copied tests after each deletion.
- `art.ts` must not use `Buffer` (it already uses `btoa`; keep it that way).
- Tests: rewrite `@/lib/...` imports to `../../src/story/...` and `@token-graph/core` to `../../src/index.js`; delete test cases for deleted functions.

`packages/core/src/story/index.ts` re-exports everything the CLI uses (the Interfaces list above plus `STORY_TEMPLATE_LABELS`, `STORY_RANGE_LABELS`, `skylineWeeks`, `storyHighlight`, the types from `data.ts`, `format.ts` helpers used by cards: `costLabel`, `fitFont`, `periodDateLabel`, `shareLabel`, `shortHandle`, `topModels`, `heroNumber`, `periodPhrase`, `storyStats`, `StoryStat`, `alpha`, `darken`, `lighten`, `makerLogoUri`, `barcodeSvg`, `heatmapSvg`, `zigzagSvg`, `renderSkyline`, `modelColors`, `modelLabel` (if story-local), `OTHER_COLOR`, `cacheHitRate`, `shiftDate`, `RangeWindow`). In `packages/core/src/index.ts` add `export * from './story/index.js';` — if any name collides with an existing core export, rename the story-side export (e.g. `storyShiftDate`) and update its users.

- [ ] **Step 3: Run the ported tests**

Run: `npx tsc --build && npx vitest run packages/core`
Expected: PASS. The story-data numbers must be identical to the web's (the tests are the web's own fixtures).

- [ ] **Step 4: Commit** (`Move story data, dashboard maths and the demo account into core`).

---

### Task 2: Cards and the PNG pipeline in the CLI

**Files:**
- Create: `packages/cli/src/story/cards/{context,skyline-card,receipt-card,sticker-card}.tsx`, `packages/cli/src/story/parts.tsx`, `packages/cli/src/story/render.tsx`
- Create: `packages/cli/assets/resvg.wasm`, `packages/cli/assets/fonts/*.ttf`, `packages/cli/assets/fonts/OFL.txt`
- Modify: `packages/cli/src/bin-path.ts` (add `assetsDir()`), `packages/cli/tsconfig.json`, `packages/cli/package.json`, `vitest.config.ts` (if JSX needs config)
- Test: `packages/cli/test/story-render.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:

```ts
// bin-path.ts
export function assetsDir(): string;   // <package root>/assets, from dist/, bundle/ and src/ alike
// story/cards/context.ts
export interface CardContext { data: StoryData; showCost: boolean; cta: string }
export const SAFE_TOP = 250; export const SAFE_BOTTOM = 1670;
export const STORY_CTA = 'npx tokengraph';
// story/render.tsx
export interface StoryRenderer {
  render(template: StoryTemplate, context: CardContext, scale?: number): Promise<Uint8Array>;
  /** RGBA pixels of any element tree, for the terminal preview. */
  rasterize(element: React.ReactElement, size: { width: number; height: number }, fitWidth: number): Promise<{ width: number; height: number; rgba: Uint8Array; png: Uint8Array }>;
}
export function createStoryRenderer(assets?: string): Promise<StoryRenderer>;
```

- [ ] **Step 1: Copy assets and cards**

```bash
WEB=/Users/orcunaltindal/codes/token-graph/apps/web
mkdir -p packages/cli/assets/fonts packages/cli/src/story/cards
cp $WEB/public/story/resvg.wasm packages/cli/assets/
cp $WEB/public/story/fonts/*.ttf packages/cli/assets/fonts/
curl -fsSL https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt -o packages/cli/assets/fonts/OFL.txt || cp /Users/orcunaltindal/codes/token-graph/node_modules/@fontsource/ibm-plex-sans/LICENSE packages/cli/assets/fonts/OFL.txt
cp $WEB/lib/story/cards/*.tsx packages/cli/src/story/cards/
cp $WEB/lib/story/parts.tsx packages/cli/src/story/parts.tsx
ls packages/cli/assets/fonts
```
If neither licence source works, write `OFL.txt` with the SIL Open Font License 1.1 full text and the line `Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"` at the top.

- [ ] **Step 2: JSX and dependencies**

```bash
npm install -D -w tokengraph react@19.2.8 @types/react@19 satori@0.25.0 @resvg/resvg-wasm@2.6.2
```
`packages/cli/tsconfig.json` `compilerOptions`: add `"jsx": "react-jsx"` and make sure `include` covers `src/**/*.tsx`. Check `vitest` transforms `.tsx` (it does by default via esbuild; if it complains about `React` not defined, add `esbuild: { jsx: 'automatic' }` to `vitest.config.ts`).

- [ ] **Step 3: Adapt the copied cards**

- Imports: `@/lib/story/<x>` / `../<x>` / `@token-graph/core` / `@/lib/logo` → `@tokengraph/core` (everything moved there in Task 1); `./context` etc. get `.js` suffixes.
- Remove the `eslint-disable` comment in `parts.tsx`.
- `context.ts` → `context.tsx` not needed; keep `context.ts` with `cta` instead of `host` and add `export const STORY_CTA = 'npx tokengraph';`.
- Every place that printed `` `${host}/u/${data.handle}` `` now prints `` `@${data.handle}` `` and the card shows `cta` once where the address used to lead the eye (skyline footer: `` `@${handle} · ${cta}` ``; receipt profile line: `` `@${handle}` `` and its footer/share strip line: `cta`; sticker: wherever `host` appeared). Demo cards keep their `sample data` / `SAMPLE ACCOUNT` text.

- [ ] **Step 4: `assetsDir()` in `bin-path.ts`**

```ts
/**
 * The package's assets folder (story fonts, resvg.wasm). Like binPath it resolves from this module's
 * own location: dist/bin-path.js, bundle/bin.js and src/bin-path.ts (tests) all sit one level
 * below the package root.
 */
export function assetsDir(): string {
  return fileURLToPath(new URL('../assets/', import.meta.url));
}
```

- [ ] **Step 5: Failing render test** — `packages/cli/test/story-render.test.ts`:

```ts
import { demoStory, STORY_SIZES, STORY_TEMPLATES } from '@tokengraph/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { STORY_CTA } from '../src/story/cards/context.js';
import { createStoryRenderer, type StoryRenderer } from '../src/story/render.js';

function size(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe('story renderer', () => {
  let renderer: StoryRenderer;
  beforeAll(async () => {
    renderer = await createStoryRenderer();
  }, 30_000);

  for (const template of STORY_TEMPLATES) {
    it(`draws ${template} at full size and scaled`, async () => {
      const context = { data: demoStory('today', new Date('2026-10-11T12:00:00Z')), showCost: true, cta: STORY_CTA };
      const full = await renderer.render(template, context);
      expect([...full.slice(0, 4)]).toEqual(PNG_SIGNATURE);
      expect(size(full)).toEqual(STORY_SIZES[template]);
      const small = await renderer.render(template, context, 0.25);
      expect(size(small).width).toBe(270);
    }, 30_000);
  }

  it('rasterizes an element to RGBA for the terminal preview', async () => {
    const out = await renderer.rasterize(<div style={{ display: 'flex', width: 40, height: 20, background: '#ff0000' }} />, { width: 40, height: 20 }, 20);
    expect(out.width).toBe(20);
    expect(out.rgba.length).toBe(out.width * out.height * 4);
    expect([...out.rgba.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });
});
```
(This test file is `.tsx`: name it `story-render.test.tsx` and make sure `vitest.config.ts` `include` matches `packages/*/test/**/*.test.{ts,tsx}`.)

- [ ] **Step 6: Implement `packages/cli/src/story/render.tsx`**

```tsx
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori, { type Font } from 'satori';
import { STORY_SIZES, type StoryTemplate } from '@tokengraph/core';
import type { ReactElement } from 'react';
import { assetsDir } from '../bin-path.js';
import type { CardContext } from './cards/context.js';
import { ReceiptCard } from './cards/receipt-card.js';
import { SkylineCard } from './cards/skyline-card.js';
import { StickerCard } from './cards/sticker-card.js';
import { MONO, SANS } from './parts.js';

type Weight = 400 | 500 | 600 | 700;

const FONT_FILES: readonly { name: string; file: string; weight: Weight }[] = [
  { name: SANS, file: 'plex-sans-400.ttf', weight: 400 },
  { name: SANS, file: 'plex-sans-500.ttf', weight: 500 },
  { name: SANS, file: 'plex-sans-600.ttf', weight: 600 },
  { name: SANS, file: 'plex-sans-700.ttf', weight: 700 },
  { name: MONO, file: 'plex-mono-400.ttf', weight: 400 },
  { name: MONO, file: 'plex-mono-500.ttf', weight: 500 },
  { name: MONO, file: 'plex-mono-600.ttf', weight: 600 },
];

const CARDS: Record<StoryTemplate, (context: CardContext) => ReactElement> = {
  skyline: SkylineCard,
  receipt: ReceiptCard,
  sticker: StickerCard,
};

export interface StoryRenderer {
  render(template: StoryTemplate, context: CardContext, scale?: number): Promise<Uint8Array>;
  rasterize(
    element: ReactElement,
    size: { width: number; height: number },
    fitWidth: number,
  ): Promise<{ width: number; height: number; rgba: Uint8Array; png: Uint8Array }>;
}

// resvg's WebAssembly can be initialised once per process.
let wasmReady: Promise<void> | null = null;

export async function createStoryRenderer(assets: string = assetsDir()): Promise<StoryRenderer> {
  wasmReady ??= readFile(join(assets, 'resvg.wasm')).then((bytes) => initWasm(bytes));
  const fonts: Font[] = await Promise.all(
    FONT_FILES.map(async (face) => ({ name: face.name, weight: face.weight, style: 'normal' as const, data: await readFile(join(assets, 'fonts', face.file)) })),
  );
  await wasmReady;

  async function draw(element: ReactElement, size: { width: number; height: number }, fit: { mode: 'original' } | { mode: 'width'; value: number } | { mode: 'zoom'; value: number }) {
    const svg = await satori(element, { ...size, fonts });
    const resvg = new Resvg(svg, { fitTo: fit, font: { loadSystemFonts: false } });
    const image = resvg.render();
    try {
      return { width: image.width, height: image.height, rgba: new Uint8Array(image.pixels), png: image.asPng() };
    } finally {
      image.free();
      resvg.free();
    }
  }

  return {
    async render(template, context, scale = 1) {
      const Card = CARDS[template];
      const fit = scale === 1 ? ({ mode: 'original' } as const) : ({ mode: 'zoom', value: scale } as const);
      return (await draw(<Card {...context} />, STORY_SIZES[template], fit)).png;
    },
    rasterize(element, size, fitWidth) {
      return draw(element, size, { mode: 'width', value: fitWidth });
    },
  };
}
```
Check the real `@resvg/resvg-wasm` typings in `node_modules/@resvg/resvg-wasm/index.d.ts`: if `RenderedImage` has no `pixels` getter, read pixels another way the typings offer and adapt `draw`; if the Satori `Font.data` type wants `ArrayBuffer`, convert the `Buffer` with `bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)`. The font file names must match `ls packages/cli/assets/fonts` — fix the list if the copied names differ.

- [ ] **Step 7: Run** `npx vitest run packages/cli/test/story-render.test.tsx` → PASS, then `npx tsc --build && npx vitest run`.

- [ ] **Step 8: Look at the cards.** Write the three full-size demo PNGs to `/tmp/tokengraph-cards/` with a one-off script (do not commit it) and open each with the Read tool: text must not overflow, `@octocat`-style handle and `npx tokengraph` must be visible inside the safe zone. Note what you saw in the report.

- [ ] **Step 9: Commit** (`Render story cards in the CLI with Satori and resvg`).

---

### Task 3: Story data from the local ledger and the other machines

**Files:**
- Create: `packages/cli/src/story/input.ts`, `packages/cli/test/story-input.test.ts`

**Interfaces:**
- Consumes: `combinedUsage`, `MachineFile` (Plan A), `readLedger`, `ledgerPath`, `readMachinesCache`, `readConfig`, core `buildStory`, `StoryRange`, `CostRow`, `ModelDayTotals`, `dateKey`, `maxNullable` (core `tokens.ts`; check its exact name and signature).
- Produces:

```ts
export function storyRows(usage: readonly DailyModelUsage[]): { rows: ModelDayTotals[]; costRows: CostRow[] };
export function storyHandle(config: CliConfig, override: string | undefined, osUser: string): string;
export function loadStoryData(options: { range: StoryRange; handle?: string; today?: string }): Promise<StoryData>;
```

- [ ] **Step 1: Failing tests** — `packages/cli/test/story-input.test.ts`:

```ts
import type { DailyModelUsage } from '@tokengraph/core';
import { buildStory } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { storyHandle, storyRows } from '../src/story/input.js';

const counts = (input: number, split: number | null) => ({
  inputTokens: input,
  outputTokens: 10,
  cacheCreationTokens: 4,
  cacheReadTokens: 100,
  cacheCreation5mTokens: split,
  cacheCreation1hTokens: split === null ? null : 0,
});

describe('storyRows', () => {
  it('sums one model-day across sources, tiers and machines; keeps tiers apart for cost', () => {
    const usage: DailyModelUsage[] = [
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(100, 4) },
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(50, 4) },
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'fast', counts: counts(5, 4) },
    ];
    const { rows, costRows } = storyRows(usage);
    expect(rows).toEqual([{ date: '2026-10-13', model: 'claude-opus-5-5', inputTokens: 155, outputTokens: 30, cacheCreationTokens: 12, cacheReadTokens: 300 }]);
    expect(costRows.map((row) => [row.pricingTier, row.inputTokens, row.cacheCreation5mTokens])).toEqual([
      ['standard', 150, 8],
      ['fast', 5, 4],
    ]);
  });

  it('an unknown cache split stays unknown when summed', () => {
    const { costRows } = storyRows([
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(1, 4) },
      { date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(1, null) },
    ]);
    expect(costRows[0]!.cacheCreation5mTokens).toBeNull();
  });

  it('feeds buildStory with totals that match the graph rule (weight per day, then sum)', () => {
    const { rows, costRows } = storyRows([{ date: '2026-10-13', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(1000, 4) }]);
    const story = buildStory({ handle: 'octocat', range: 'today', todayUtc: '2026-10-13', rows, costRows });
    expect(story.total).toBe(1000 + 10 + 4 + 10);
  });

  it('builds an empty story without crashing', () => {
    const story = buildStory({ handle: 'octocat', range: '7d', todayUtc: '2026-10-13', ...storyRows([]) });
    expect(story.total).toBe(0);
  });
});

describe('storyHandle', () => {
  it('prefers --handle, then the GitHub login, then the OS user', () => {
    expect(storyHandle({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } } }, 'me', 'os')).toBe('me');
    expect(storyHandle({ github: { login: 'octocat', auth: { kind: 'token', token: 't' } } }, undefined, 'os')).toBe('octocat');
    expect(storyHandle({}, undefined, 'os')).toBe('os');
    expect(storyHandle({}, '@me', 'os')).toBe('me');
  });
});
```

- [ ] **Step 2: Implement `packages/cli/src/story/input.ts`**

```ts
import { userInfo } from 'node:os';
import { buildStory, dateKey, type CostRow, type DailyModelUsage, type ModelDayTotals, type StoryData, type StoryRange } from '@tokengraph/core';
import { readConfig, type CliConfig } from '../config.js';
import { readLedger } from '../ledger.js';
import { ledgerPath } from '../paths.js';
import { combinedUsage } from '../publish/machines.js';
import { readMachinesCache } from '../publish/machines-cache.js';

const addNullable = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

/** Per model-day rows for the cards and per model-day-tier rows for cost, summed over sources and machines. */
export function storyRows(usage: readonly DailyModelUsage[]): { rows: ModelDayTotals[]; costRows: CostRow[] } {
  const rows = new Map<string, ModelDayTotals>();
  const costRows = new Map<string, CostRow>();
  for (const entry of usage) {
    const c = entry.counts;
    const rowKey = `${entry.date}|${entry.model}`;
    const row = rows.get(rowKey) ?? { date: entry.date, model: entry.model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    row.inputTokens += c.inputTokens;
    row.outputTokens += c.outputTokens;
    row.cacheCreationTokens += c.cacheCreationTokens;
    row.cacheReadTokens += c.cacheReadTokens;
    rows.set(rowKey, row);

    const costKey = `${rowKey}|${entry.pricingTier}`;
    const cost = costRows.get(costKey);
    if (!cost) {
      costRows.set(costKey, {
        date: entry.date,
        model: entry.model,
        pricingTier: entry.pricingTier,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens,
        cacheCreationTokens: c.cacheCreationTokens,
        cacheCreation5mTokens: c.cacheCreation5mTokens,
        cacheCreation1hTokens: c.cacheCreation1hTokens,
      });
    } else {
      cost.inputTokens += c.inputTokens;
      cost.outputTokens += c.outputTokens;
      cost.cacheReadTokens += c.cacheReadTokens;
      cost.cacheCreationTokens += c.cacheCreationTokens;
      cost.cacheCreation5mTokens = addNullable(cost.cacheCreation5mTokens, c.cacheCreation5mTokens);
      cost.cacheCreation1hTokens = addNullable(cost.cacheCreation1hTokens, c.cacheCreation1hTokens);
    }
  }
  return { rows: [...rows.values()], costRows: [...costRows.values()] };
}

export function storyHandle(config: CliConfig, override: string | undefined, osUser: string): string {
  const handle = override?.replace(/^@/, '') || config.github?.login || osUser;
  return handle || 'me';
}

function osUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/** Offline: this machine's ledger plus the other machines as of the last publish. */
export async function loadStoryData(options: { range: StoryRange; handle?: string; today?: string }): Promise<StoryData> {
  const [config, ledger, others] = await Promise.all([readConfig(), readLedger(ledgerPath()), readMachinesCache()]);
  const { rows, costRows } = storyRows(combinedUsage(ledger, others));
  return buildStory({
    handle: storyHandle(config, options.handle, osUserName()),
    range: options.range,
    todayUtc: options.today ?? dateKey(new Date()),
    rows,
    costRows,
  });
}
```
Use the real `dateKey` signature (local date, as `sync` does).

- [ ] **Step 3: Run tests** → PASS. **Step 4: Commit** (`Build story data from the ledger and other machines`).

---

### Task 4: Terminal image preview

**Files:**
- Create: `packages/cli/src/story/term-image.ts`, `packages/cli/src/story/preview.tsx`
- Test: `packages/cli/test/term-image.test.ts`

**Interfaces:**
- Consumes: `StoryRenderer.rasterize` (Task 2).
- Produces:

```ts
// term-image.ts
export type ImageProtocol = 'iterm' | 'kitty' | 'none';
export function detectImageProtocol(env: NodeJS.ProcessEnv): ImageProtocol;
export function supportsTruecolor(env: NodeJS.ProcessEnv): boolean;
export function itermImage(png: Uint8Array, widthCells: number): string;
export function kittyImage(png: Uint8Array, widthCells: number): string;
export function halfBlockImage(rgba: Uint8Array, width: number, height: number, options: { truecolor: boolean; background?: [number, number, number] }): string[];
export function rgbTo256(r: number, g: number, b: number): number;
// preview.tsx
export function previewStrip(renderer: StoryRenderer, cards: readonly { template: StoryTemplate; png: Uint8Array }[], options: { env: NodeJS.ProcessEnv; columns: number }): Promise<string>;
```

- [ ] **Step 1: Failing tests** — `packages/cli/test/term-image.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectImageProtocol, halfBlockImage, itermImage, kittyImage, rgbTo256, supportsTruecolor } from '../src/story/term-image.js';

describe('detectImageProtocol', () => {
  it('knows the terminals that draw images', () => {
    expect(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm');
    expect(detectImageProtocol({ TERM_PROGRAM: 'WezTerm' })).toBe('iterm');
    expect(detectImageProtocol({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectImageProtocol({ TERM: 'xterm-kitty' })).toBe('kitty');
    expect(detectImageProtocol({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
    expect(detectImageProtocol({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('none');
    expect(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux' })).toBe('none');
  });

  it('reads truecolor support from COLORTERM', () => {
    expect(supportsTruecolor({ COLORTERM: 'truecolor' })).toBe(true);
    expect(supportsTruecolor({ COLORTERM: '24bit' })).toBe(true);
    expect(supportsTruecolor({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
  });
});

describe('encoders', () => {
  const png = new Uint8Array(5000).fill(7);

  it('wraps an iTerm2 inline image', () => {
    const out = itermImage(png, 60);
    expect(out.startsWith('\x1b]1337;File=inline=1;size=5000;width=60;preserveAspectRatio=1:')).toBe(true);
    expect(out.endsWith('\x07')).toBe(true);
  });

  it('chunks a Kitty image at 4096 base64 characters', () => {
    const out = kittyImage(png, 60);
    const chunks = out.split('\x1b\\').filter(Boolean);
    expect(chunks[0]!.startsWith('\x1b_Gf=100,a=T,c=60,m=1;')).toBe(true);
    expect(chunks.at(-1)!.startsWith('\x1b_Gm=0;')).toBe(true);
    for (const chunk of chunks) expect(chunk.split(';')[1]!.length).toBeLessThanOrEqual(4096);
  });
});

describe('halfBlockImage', () => {
  // 1 px wide, 2 px tall: red over blue.
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);

  it('draws two pixels per cell in truecolor', () => {
    expect(halfBlockImage(rgba, 1, 2, { truecolor: true })).toEqual(['\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀\x1b[0m']);
  });

  it('falls back to the 256-colour cube', () => {
    expect(halfBlockImage(rgba, 1, 2, { truecolor: false })).toEqual([`\x1b[38;5;${rgbTo256(255, 0, 0)}m\x1b[48;5;${rgbTo256(0, 0, 255)}m▀\x1b[0m`]);
    expect(rgbTo256(255, 0, 0)).toBe(196);
    expect(rgbTo256(0, 0, 0)).toBe(16);
  });

  it('blends transparency onto the background and pads an odd height', () => {
    const transparent = new Uint8Array([255, 255, 255, 0]);
    expect(halfBlockImage(transparent, 1, 1, { truecolor: true, background: [10, 20, 30] })).toEqual(['\x1b[38;2;10;20;30m\x1b[48;2;10;20;30m▀\x1b[0m']);
  });
});
```

- [ ] **Step 2: Implement `packages/cli/src/story/term-image.ts`**

```ts
export type ImageProtocol = 'iterm' | 'kitty' | 'none';

/** Terminals that draw real images inline. Inside tmux the escapes need passthrough, so no. */
export function detectImageProtocol(env: NodeJS.ProcessEnv): ImageProtocol {
  if (env['TMUX']) return 'none';
  const program = env['TERM_PROGRAM'];
  if (program === 'iTerm.app' || program === 'WezTerm') return 'iterm';
  if (env['KITTY_WINDOW_ID'] || env['TERM'] === 'xterm-kitty' || program === 'ghostty') return 'kitty';
  return 'none';
}

export function supportsTruecolor(env: NodeJS.ProcessEnv): boolean {
  return env['COLORTERM'] === 'truecolor' || env['COLORTERM'] === '24bit';
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export function itermImage(png: Uint8Array, widthCells: number): string {
  return `\x1b]1337;File=inline=1;size=${png.length};width=${widthCells};preserveAspectRatio=1:${base64(png)}\x07`;
}

const KITTY_CHUNK = 4096;

export function kittyImage(png: Uint8Array, widthCells: number): string {
  const data = base64(png);
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += KITTY_CHUNK) {
    const chunk = data.slice(i, i + KITTY_CHUNK);
    const more = i + KITTY_CHUNK < data.length ? 1 : 0;
    parts.push(i === 0 ? `\x1b_Gf=100,a=T,c=${widthCells},m=${more};${chunk}\x1b\\` : `\x1b_Gm=${more};${chunk}\x1b\\`);
  }
  return parts.join('');
}

/** xterm 256-colour cube index (16..231) for an RGB colour. */
export function rgbTo256(r: number, g: number, b: number): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

type Rgb = [number, number, number];

function pixel(rgba: Uint8Array, width: number, height: number, x: number, y: number, background: Rgb): Rgb {
  if (y >= height) return background;
  const i = (y * width + x) * 4;
  const alpha = rgba[i + 3]! / 255;
  return [0, 1, 2].map((c) => Math.round(rgba[i + c]! * alpha + background[c]! * (1 - alpha))) as Rgb;
}

/** Two vertical pixels per character cell: the top one as foreground of ▀, the bottom one as background. */
export function halfBlockImage(rgba: Uint8Array, width: number, height: number, options: { truecolor: boolean; background?: Rgb }): string[] {
  const background = options.background ?? [0, 0, 0];
  const fg = ([r, g, b]: Rgb) => (options.truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`);
  const bg = ([r, g, b]: Rgb) => (options.truecolor ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${rgbTo256(r, g, b)}m`);
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = '';
    for (let x = 0; x < width; x += 1) {
      line += `${fg(pixel(rgba, width, height, x, y, background))}${bg(pixel(rgba, width, height, x, y + 1, background))}▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}
```

- [ ] **Step 3: Implement `packages/cli/src/story/preview.tsx`**

```tsx
import { STORY_SIZES, type StoryTemplate } from '@tokengraph/core';
import type { StoryRenderer } from './render.js';
import { detectImageProtocol, halfBlockImage, itermImage, kittyImage, supportsTruecolor } from './term-image.js';

const GAP = 24;
const THUMB_WIDTH = 270;

/** The cards side by side as one picture: a real image where the terminal can draw one, half blocks elsewhere. */
export async function previewStrip(
  renderer: StoryRenderer,
  cards: readonly { template: StoryTemplate; png: Uint8Array }[],
  options: { env: NodeJS.ProcessEnv; columns: number },
): Promise<string> {
  const thumbs = cards.map((card) => ({ ...card, height: Math.round((STORY_SIZES[card.template].height / STORY_SIZES[card.template].width) * THUMB_WIDTH) }));
  const width = thumbs.length * THUMB_WIDTH + (thumbs.length - 1) * GAP;
  const height = Math.max(...thumbs.map((thumb) => thumb.height));
  const strip = (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', width, height }}>
      {thumbs.map((thumb, index) => (
        <img
          key={thumb.template}
          src={`data:image/png;base64,${Buffer.from(thumb.png).toString('base64')}`}
          width={THUMB_WIDTH}
          height={thumb.height}
          style={{ marginLeft: index === 0 ? 0 : GAP, borderRadius: 18 }}
        />
      ))}
    </div>
  );
  const protocol = detectImageProtocol(options.env);
  const widthCells = Math.max(30, Math.min(options.columns - 4, 120));
  if (protocol !== 'none') {
    const { png } = await renderer.rasterize(strip, { width, height }, Math.min(width, widthCells * 10));
    return `  ${protocol === 'iterm' ? itermImage(png, widthCells) : kittyImage(png, widthCells)}\n`;
  }
  const pixelsWide = Math.max(30, Math.min(options.columns - 4, 96));
  const { width: w, height: h, rgba } = await renderer.rasterize(strip, { width, height }, pixelsWide);
  return halfBlockImage(rgba, w, h, { truecolor: supportsTruecolor(options.env) })
    .map((line) => `  ${line}`)
    .join('\n');
}
```

- [ ] **Step 4: Run tests** → PASS. Then print a real preview once (one-off script, not committed) with `TERM_PROGRAM=Apple_Terminal` env and look at it in the tool output to confirm three card silhouettes appear. **Step 5: Commit** (`Preview story cards in the terminal`).

---

### Task 5: QR code in the terminal

**Files:**
- Create: `packages/cli/src/share/qr.ts`, `packages/cli/test/share-qr.test.ts`
- Modify: `packages/cli/package.json` (devDependencies `qrcode-generator@2.0.4`; root devDependency `jsqr@1.4.0`)

**Interfaces:**
- Produces:

```ts
export function qrMatrix(text: string): boolean[][];          // true = dark module, no quiet zone
export function qrLines(matrix: boolean[][], quiet?: number): string[];  // half-block lines, forced black on white
```

- [ ] **Step 1: Install**

```bash
npm install -D -w tokengraph qrcode-generator@2.0.4
npm install -D jsqr@1.4.0
```

- [ ] **Step 2: Failing test** — `packages/cli/test/share-qr.test.ts`:

```ts
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { qrLines, qrMatrix } from '../src/share/qr.js';

function toPixels(matrix: boolean[][], quiet: number, scale: number) {
  const size = (matrix.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy += 1)
        for (let dx = 0; dx < scale; dx += 1) {
          const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }),
  );
  return { data, size };
}

describe('qr', () => {
  const url = 'http://192.168.1.23:53211/Xq3v9cJfL2mN8pR4sT6uWy/';

  it('encodes a URL that a QR reader decodes back', () => {
    const matrix = qrMatrix(url);
    const { data, size } = toPixels(matrix, 4, 6);
    expect(jsQR(data, size, size)?.data).toBe(url);
  });

  it('draws two module rows per line with the quiet zone, forced black on white', () => {
    const matrix = qrMatrix(url);
    const lines = qrLines(matrix);
    expect(lines).toHaveLength(Math.ceil((matrix.length + 8) / 2));
    for (const line of lines) {
      expect(line.startsWith('\x1b[38;5;16m\x1b[48;5;231m')).toBe(true);
      expect(line.endsWith('\x1b[0m')).toBe(true);
      expect(line.replace(/\x1b\[[0-9;]*m/g, '')).toHaveLength(matrix.length + 8);
    }
  });
});
```

- [ ] **Step 3: Implement `packages/cli/src/share/qr.ts`**

```ts
import qrcode from 'qrcode-generator';

/** Error correction M: survives a smudged screen and still fits a LAN URL in a small symbol. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

const INK = '\x1b[38;5;16m';
const PAPER = '\x1b[48;5;231m';
const RESET = '\x1b[0m';

/**
 * Two module rows per text line. Colours are forced (black ink on white paper) because a phone
 * camera reads dark-on-light; a dark terminal theme would otherwise invert the code.
 */
export function qrLines(matrix: boolean[][], quiet = 4): string[] {
  const size = matrix.length + quiet * 2;
  const dark = (row: number, col: number) => {
    const r = row - quiet;
    const c = col - quiet;
    return r >= 0 && c >= 0 && r < matrix.length && c < matrix.length && matrix[r]![c]!;
  };
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`${INK}${PAPER}${line}${RESET}`);
  }
  return lines;
}
```
If `qrcode-generator@2` exports differently (named export or no types), adapt the import to what its `package.json` / typings declare.

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** (`Draw scannable QR codes in the terminal`).

---

### Task 6: LAN address, the phone page and the share server

**Files:**
- Create: `packages/cli/src/share/lan.ts`, `packages/cli/src/share/page.ts`, `packages/cli/src/share/server.ts`
- Test: `packages/cli/test/share-lan.test.ts`, `packages/cli/test/share-server.test.ts`

**Interfaces:**
- Consumes: `logoLockupSvg` from core.
- Produces:

```ts
// lan.ts
export function isPrivateIPv4(address: string): boolean;
export function pickLanAddress(interfaces: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>): string | null;
// page.ts
export interface PageCard { id: string; title: string; fileName: string; width: number; height: number }
export function phonePage(cards: readonly PageCard[], options: { handle: string }): string;
// server.ts
export interface ShareCard extends PageCard { png: Uint8Array }
export type ShareEvent = { kind: 'page'; userAgent: string } | { kind: 'saved'; id: string };
export type StopReason = 'all-saved' | 'idle' | 'stopped';
export interface ShareServer { url: string; done: Promise<StopReason>; stop(): void }
export function startShareServer(options: {
  address: string; cards: readonly ShareCard[]; handle: string;
  onEvent?: (event: ShareEvent) => void; idleMs?: number; afterAllSavedMs?: number; token?: string;
}): Promise<ShareServer>;
```

- [ ] **Step 1: Failing LAN test** — `packages/cli/test/share-lan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPrivateIPv4, pickLanAddress } from '../src/share/lan.js';

const nic = (address: string, internal = false, family: 'IPv4' | 'IPv6' = 'IPv4') =>
  ({ address, internal, family, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as const;

describe('lan', () => {
  it('knows private ranges', () => {
    expect(['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.23'].every(isPrivateIPv4)).toBe(true);
    expect(['172.32.0.1', '8.8.8.8', '100.64.0.1', '169.254.1.1'].some(isPrivateIPv4)).toBe(false);
  });

  it('prefers Wi-Fi/Ethernet over VPN and virtual interfaces', () => {
    expect(
      pickLanAddress({
        lo0: [nic('127.0.0.1', true)],
        utun3: [nic('10.8.0.2')],
        bridge100: [nic('192.168.64.1')],
        en0: [nic('fe80::1', false, 'IPv6'), nic('192.168.1.23')],
      }),
    ).toBe('192.168.1.23');
  });

  it('takes any private address when no preferred interface has one, and null when none', () => {
    expect(pickLanAddress({ eth7: [nic('10.0.0.9')] })).toBe('10.0.0.9');
    expect(pickLanAddress({ lo0: [nic('127.0.0.1', true)], utun0: [nic('100.64.0.1')] })).toBeNull();
  });
});
```

- [ ] **Step 2: Implement `packages/cli/src/share/lan.ts`**

```ts
import type { NetworkInterfaceInfo } from 'node:os';

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Wi-Fi and Ethernet first; VPN tunnels and VM bridges are where a phone cannot reach.
const PREFERRED = /^(en|eth|wlan|wl|wlp|enp|eno|ens|Wi-?Fi|Ethernet)/i;
const VIRTUAL = /^(utun|tun|tap|bridge|vboxnet|vmnet|docker|br-|veth|virbr|lo|awdl|llw|zt|tailscale)/i;

export function pickLanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) candidates.push({ name, address: entry.address });
    }
  }
  const preferred = candidates.find((c) => PREFERRED.test(c.name) && !VIRTUAL.test(c.name));
  const other = candidates.find((c) => !VIRTUAL.test(c.name));
  return (preferred ?? other)?.address ?? null;
}
```

- [ ] **Step 3: Implement `packages/cli/src/share/page.ts`**

The page is the moment the person sees their cards on the phone: make it beautiful. Requirements:
- `<!doctype html>`, `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`, `<meta name="color-scheme" content="dark">`, `<title>Your tokengraph stories</title>`.
- Dark background `#0b0b0d`, ink `#f4f4f5`, muted `#a1a1aa`, accent the logo red `#ef4444`. System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`. Respect `env(safe-area-inset-*)`.
- Header: the tokengraph lockup (`logoLockupSvg('dark')` inlined as SVG markup, 28px tall), then `Hi @<handle> — your story cards are ready.`
- One section per card, vertical scroll: the card image (`<img src="card/<id>.png" width height alt="<title> story card">`, rounded 20px, subtle 1px border `#27272a`, `width:100%; height:auto`), its title, and a full-width **Save** button: `<a class="save" href="card/<id>.png?download=1" download="<fileName>">Save</a>` (accent background, 48px tall, 14px radius).
- A hint box under the header, chosen by a tiny inline script from `navigator.userAgent`: iPhone/iPad → "Touch and hold a card, then tap **Save to Photos**."; Android → "Touch and hold a card, then tap **Download image**."; otherwise "Use **Save** under each card."
- When `navigator.canShare && navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] })` is true, add a **Share** button per card that fetches the PNG and calls `navigator.share({ files: [file] })` (progressive: absent on plain http on most phones).
- Footer: `Made with tokengraph · npx tokengraph` in muted text.
- Every interpolated string goes through an `escapeHtml` helper. No external URL anywhere in the document.

- [ ] **Step 4: Failing server test** — `packages/cli/test/share-server.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startShareServer, type ShareEvent, type ShareServer } from '../src/share/server.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const cards = [
  { id: 'skyline', title: 'Skyline', fileName: 'a-skyline.png', width: 1080, height: 1920, png },
  { id: 'receipt', title: 'Receipt', fileName: 'a-receipt.png', width: 1080, height: 1920, png },
];

let server: ShareServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  vi.useRealTimers();
});

describe('share server', () => {
  it('serves the page and the cards under the token only', async () => {
    const events: ShareEvent[] = [];
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', onEvent: (e) => events.push(e) });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/);

    const page = await fetch(server.url, { headers: { 'user-agent': 'iPhone' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('card/skyline.png');
    expect(html).not.toMatch(/https?:\/\//);

    const image = await fetch(`${server.url}card/skyline.png`);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);

    const saved = await fetch(`${server.url}card/receipt.png?download=1`);
    expect(saved.headers.get('content-disposition')).toBe('attachment; filename="a-receipt.png"');
    await saved.arrayBuffer();

    const origin = server.url.replace(/[^/]+\/$/, '');
    expect((await fetch(origin)).status).toBe(404);
    expect((await fetch(`${origin}wrongtoken/`)).status).toBe(404);
    expect((await fetch(`${server.url}card/nope.png`)).status).toBe(404);
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(405);
    expect(events).toEqual([{ kind: 'page', userAgent: 'iPhone' }, { kind: 'saved', id: 'receipt' }]);
  });

  it('stops after every card was saved', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', afterAllSavedMs: 20 });
    for (const card of cards) await (await fetch(`${server.url}card/${card.id}.png?download=1`)).arrayBuffer();
    expect(await server.done).toBe('all-saved');
  });

  it('stops when idle and when asked', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', idleMs: 30 });
    expect(await server.done).toBe('idle');
    const other = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat' });
    other.stop();
    expect(await other.done).toBe('stopped');
  });
});
```

- [ ] **Step 5: Implement `packages/cli/src/share/server.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { phonePage, type PageCard } from './page.js';

export interface ShareCard extends PageCard {
  png: Uint8Array;
}
export type ShareEvent = { kind: 'page'; userAgent: string } | { kind: 'saved'; id: string };
export type StopReason = 'all-saved' | 'idle' | 'stopped';
export interface ShareServer {
  url: string;
  done: Promise<StopReason>;
  stop(): void;
}

const IDLE_MS = 10 * 60_000;
const AFTER_ALL_SAVED_MS = 30_000;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * A one-off web server for the phone on the same network: one random path token, the cards from
 * memory, nothing from disk, and it always ends.
 */
export async function startShareServer(options: {
  address: string;
  cards: readonly ShareCard[];
  handle: string;
  onEvent?: (event: ShareEvent) => void;
  idleMs?: number;
  afterAllSavedMs?: number;
  token?: string;
}): Promise<ShareServer> {
  const token = options.token ?? randomBytes(16).toString('base64url');
  const prefix = `/${token}/`;
  const page = phonePage(options.cards, { handle: options.handle });
  const saved = new Set<string>();
  let finish: (reason: StopReason) => void = () => undefined;
  const done = new Promise<StopReason>((resolve) => {
    finish = resolve;
  });
  let idleTimer: NodeJS.Timeout | undefined;
  let endTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const server = createServer((req, res) => {
    armIdle();
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' }).end();
      return;
    }
    const rest = url.pathname.slice(prefix.length);
    if (rest === '') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(req.method === 'HEAD' ? undefined : page);
      if (req.method === 'GET') options.onEvent?.({ kind: 'page', userAgent: String(req.headers['user-agent'] ?? '') });
      return;
    }
    const match = /^card\/([a-z]+)\.png$/.exec(rest);
    const card = match ? options.cards.find((c) => c.id === match[1]) : undefined;
    if (!card) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    const download = url.searchParams.get('download') === '1';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'image/png',
      'Content-Length': String(card.png.length),
      ...(download ? { 'Content-Disposition': `attachment; filename="${card.fileName}"` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : card.png);
    if (download && req.method === 'GET') {
      saved.add(card.id);
      options.onEvent?.({ kind: 'saved', id: card.id });
      if (saved.size === options.cards.length) {
        clearTimeout(endTimer);
        endTimer = setTimeout(() => stop('all-saved'), options.afterAllSavedMs ?? AFTER_ALL_SAVED_MS);
      }
    }
  });

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('idle'), options.idleMs ?? IDLE_MS);
  }

  function stop(reason: StopReason) {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(endTimer);
    server.close();
    server.closeAllConnections();
    finish(reason);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.address, () => resolve());
  });
  armIdle();
  const { port } = server.address() as AddressInfo;
  return { url: `http://${options.address}:${port}${prefix}`, done, stop: () => stop('stopped') };
}
```

- [ ] **Step 6: Run tests** → PASS. Then render the page with the real demo cards into `/tmp/tokengraph-share/index.html` (one-off, not committed) and look at it at phone width (390px) with headless Chrome or by reading the HTML; record what you checked. **Step 7: Commit** (`Serve story cards to a phone on the local network`).

---

### Task 7: The `story` command

**Files:**
- Create: `packages/cli/src/commands/story.ts`, `packages/cli/test/story-command.test.ts`
- Modify: `packages/cli/src/bin.ts`

**Interfaces:**
- Consumes: Tasks 2–6, `askYesNo`, `revealInFileManager`, core `STORY_TEMPLATES`, `STORY_RANGES`, `STORY_SIZES`, `STORY_TEMPLATE_LABELS`, `storyFileName`.
- Produces:

```ts
export interface StoryCommandOptions {
  templates: StoryTemplate[]; range: StoryRange; showCost: boolean; outDir?: string;
  qr: 'ask' | 'yes' | 'no'; preview: boolean; handle?: string;
}
export interface StoryDeps {
  isTTY: boolean; env: NodeJS.ProcessEnv; columns: number; platform: NodeJS.Platform; home: string;
  loadData: (range: StoryRange, handle?: string) => Promise<StoryData>;
  renderer: () => Promise<StoryRenderer>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  exists: (path: string) => boolean;
  ask: (question: string) => Promise<boolean>;
  lanAddress: () => string | null;
  startShare: typeof startShareServer;
  reveal: (path: string) => void;
  out: (text: string) => void;
  onInterrupt: (handler: () => void) => () => void;
}
export function runStory(options: StoryCommandOptions, overrides?: Partial<StoryDeps>): Promise<number>;
export function parseStoryArgs(values: Record<string, string | boolean | undefined>): StoryCommandOptions | string;  // string = error message
```

- [ ] **Step 1: Failing tests** — `packages/cli/test/story-command.test.ts`:

```ts
import { demoStory } from '@tokengraph/core';
import { describe, expect, it, vi } from 'vitest';
import { parseStoryArgs, runStory, type StoryDeps } from '../src/commands/story.js';

const fakeRenderer = async () => ({
  render: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  rasterize: async () => ({ width: 2, height: 2, rgba: new Uint8Array(16), png: new Uint8Array(4) }),
});

function deps(overrides: Partial<StoryDeps> = {}) {
  const written: string[] = [];
  const output: string[] = [];
  const base: Partial<StoryDeps> = {
    isTTY: true,
    env: { TERM_PROGRAM: 'Apple_Terminal' },
    columns: 100,
    platform: 'linux',
    home: '/home/me',
    loadData: async (range) => ({ ...demoStory(range, new Date('2026-10-11T12:00:00Z')), handle: 'octocat', demo: false }),
    renderer: fakeRenderer,
    writeFile: async (path) => {
      written.push(path);
    },
    exists: (path) => path === '/home/me/Downloads',
    ask: async () => false,
    lanAddress: () => '127.0.0.1',
    reveal: () => undefined,
    out: (text) => output.push(text),
    onInterrupt: () => () => undefined,
    ...overrides,
  };
  return { deps: base, written, output };
}

describe('parseStoryArgs', () => {
  it('reads the defaults and validates values', () => {
    expect(parseStoryArgs({})).toEqual({ templates: ['skyline', 'receipt', 'sticker'], range: 'today', showCost: true, qr: 'ask', preview: true });
    expect(parseStoryArgs({ template: 'receipt', range: '7d', 'no-cost': true, qr: true, 'no-preview': true, out: '/x', handle: 'me' })).toEqual({
      templates: ['receipt'], range: '7d', showCost: false, qr: 'yes', preview: false, outDir: '/x', handle: 'me',
    });
    expect(parseStoryArgs({ 'no-qr': true })).toMatchObject({ qr: 'no' });
    expect(parseStoryArgs({ template: 'poster' })).toBe('--template must be skyline, receipt, sticker or all.');
    expect(parseStoryArgs({ range: '2y' })).toBe('--range must be today, 7d, 30d or 1y.');
    expect(parseStoryArgs({ qr: true, 'no-qr': true })).toBe('Choose one of --qr and --no-qr.');
  });
});

describe('runStory', () => {
  it('saves every card to ~/Downloads with its file name', async () => {
    const { deps: d, written } = deps();
    expect(await runStory(parseStoryArgs({ 'no-qr': true }) as never, d)).toBe(0);
    expect(written).toEqual([
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-receipt.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-sticker.png',
    ]);
  });

  it('falls back to the home folder without a Downloads folder', async () => {
    const { deps: d, written } = deps({ exists: () => false });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, d);
    expect(written).toEqual(['/home/me/tokengraph-octocat-2026-10-11-skyline.png']);
  });

  it('shares when the person says yes and stops when the server stops', async () => {
    const startShare = vi.fn(async () => ({ url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('all-saved' as const), stop: () => undefined }));
    const { deps: d, output } = deps({ ask: async () => true, startShare });
    expect(await runStory(parseStoryArgs({}) as never, d)).toBe(0);
    expect(startShare).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('http://127.0.0.1:1/tok/');
  });

  it('explains when there is no local network and still succeeds', async () => {
    const { deps: d, output } = deps({ lanAddress: () => null });
    expect(await runStory(parseStoryArgs({ qr: true }) as never, d)).toBe(0);
    expect(output.join('\n')).toMatch(/Wi-Fi|network/);
  });

  it('never asks or previews without a terminal', async () => {
    const ask = vi.fn(async () => true);
    const renderer = vi.fn(fakeRenderer);
    const { deps: d } = deps({ isTTY: false, ask, renderer });
    await runStory(parseStoryArgs({}) as never, d);
    expect(ask).not.toHaveBeenCalled();
  });
});
```
(Adjust the expected file names to what `storyFileName` actually produces for the demo story's end date.)

- [ ] **Step 2: Implement `packages/cli/src/commands/story.ts`**

```ts
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import {
  STORY_RANGES,
  STORY_SIZES,
  STORY_TEMPLATE_LABELS,
  STORY_TEMPLATES,
  storyFileName,
  type StoryData,
  type StoryRange,
  type StoryTemplate,
} from '@tokengraph/core';
import { revealInFileManager } from '../open-url.js';
import { askYesNo } from '../prompt.js';
import { pickLanAddress } from '../share/lan.js';
import { qrLines, qrMatrix } from '../share/qr.js';
import { startShareServer, type ShareCard } from '../share/server.js';
import { STORY_CTA } from '../story/cards/context.js';
import { loadStoryData } from '../story/input.js';
import { previewStrip } from '../story/preview.js';
import { createStoryRenderer, type StoryRenderer } from '../story/render.js';

export interface StoryCommandOptions {
  templates: StoryTemplate[];
  range: StoryRange;
  showCost: boolean;
  outDir?: string;
  qr: 'ask' | 'yes' | 'no';
  preview: boolean;
  handle?: string;
}

export interface StoryDeps {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  columns: number;
  platform: NodeJS.Platform;
  home: string;
  loadData: (range: StoryRange, handle?: string) => Promise<StoryData>;
  renderer: () => Promise<StoryRenderer>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  exists: (path: string) => boolean;
  ask: (question: string) => Promise<boolean>;
  lanAddress: () => string | null;
  startShare: typeof startShareServer;
  reveal: (path: string) => void;
  out: (text: string) => void;
  onInterrupt: (handler: () => void) => () => void;
}

export function parseStoryArgs(values: Record<string, string | boolean | undefined>): StoryCommandOptions | string {
  const template = values['template'] ?? 'all';
  const templates = template === 'all' ? [...STORY_TEMPLATES] : STORY_TEMPLATES.filter((t) => t === template);
  if (templates.length === 0) return '--template must be skyline, receipt, sticker or all.';
  const range = values['range'] ?? 'today';
  if (!STORY_RANGES.includes(range as StoryRange)) return '--range must be today, 7d, 30d or 1y.';
  if (values['qr'] && values['no-qr']) return 'Choose one of --qr and --no-qr.';
  const options: StoryCommandOptions = {
    templates,
    range: range as StoryRange,
    showCost: !values['no-cost'],
    qr: values['qr'] ? 'yes' : values['no-qr'] ? 'no' : 'ask',
    preview: !values['no-preview'],
  };
  if (typeof values['out'] === 'string') options.outDir = values['out'];
  if (typeof values['handle'] === 'string') options.handle = values['handle'];
  return options;
}

function defaultDeps(): StoryDeps {
  return {
    isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    env: process.env,
    columns: process.stdout.columns ?? 80,
    platform: process.platform,
    home: homedir(),
    loadData: (range, handle) => loadStoryData({ range, handle }),
    renderer: () => createStoryRenderer(),
    writeFile: (path, bytes) => writeFile(path, bytes),
    exists: existsSync,
    ask: (question) => askYesNo(question),
    lanAddress: () => pickLanAddress(networkInterfaces()),
    startShare: startShareServer,
    reveal: revealInFileManager,
    out: (text) => process.stdout.write(`${text}\n`),
    onInterrupt: (handler) => {
      process.once('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}

const dim = (text: string, tty: boolean) => (tty ? `\x1b[2m${text}\x1b[22m` : text);
const bold = (text: string, tty: boolean) => (tty ? `\x1b[1m${text}\x1b[22m` : text);

export async function runStory(options: StoryCommandOptions, overrides: Partial<StoryDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const tty = deps.isTTY;
  const data = await deps.loadData(options.range, options.handle);
  deps.out(`\n${bold('tokengraph story', tty)}  ${dim(`${options.range} · @${data.handle}`, tty)}\n`);

  const renderer = await deps.renderer();
  const cards: ShareCard[] = [];
  const outDir = options.outDir ?? (deps.exists(join(deps.home, 'Downloads')) ? join(deps.home, 'Downloads') : deps.home);
  if (options.outDir) mkdirSync(outDir, { recursive: true });
  for (const template of options.templates) {
    const png = await renderer.render(template, { data, showCost: options.showCost, cta: STORY_CTA });
    const fileName = storyFileName(data.handle, data.endDate, { template, range: options.range, showCost: options.showCost });
    await deps.writeFile(join(outDir, fileName), png);
    cards.push({ id: template, title: STORY_TEMPLATE_LABELS[template].name, fileName, png, ...STORY_SIZES[template] });
    deps.out(`  ${tty ? '✓' : '-'} ${STORY_TEMPLATE_LABELS[template].name}`);
  }

  if (tty && options.preview) {
    deps.out('');
    deps.out(await previewStrip(renderer, cards.map((card) => ({ template: card.id as StoryTemplate, png: card.png })), { env: deps.env, columns: deps.columns }));
  }

  deps.out(`\nSaved to ${outDir}`);
  for (const card of cards) deps.out(`  ${card.fileName}`);

  const share = options.qr === 'yes' || (options.qr === 'ask' && tty && (await deps.ask('\nSend them to your phone?')));
  if (!share) {
    if (tty && deps.platform === 'darwin') deps.reveal(join(outDir, cards[0]!.fileName));
    return 0;
  }

  const address = deps.lanAddress();
  if (!address) {
    deps.out('\nNo Wi-Fi or Ethernet network found, so the phone cannot reach this computer. The cards are saved above;');
    deps.out('AirDrop them, or connect to a network and run `tokengraph story --qr`.');
    return 0;
  }

  const server = await deps.startShare({
    address,
    cards,
    handle: data.handle,
    onEvent: (event) => deps.out(event.kind === 'page' ? '  📱 Phone connected' : `  ✓ ${cards.find((c) => c.id === event.id)?.title ?? event.id} saved`),
  });
  deps.out('');
  for (const line of qrLines(qrMatrix(server.url))) deps.out(`  ${line}`);
  deps.out(`\n  Scan with your phone's camera  ${dim(server.url, tty)}`);
  deps.out(dim('  Your phone and this computer must be on the same Wi-Fi. Office and guest networks may block it.', tty));
  if (deps.platform === 'darwin') deps.out(dim('  If macOS asks whether node may accept incoming connections, choose Allow.', tty));
  deps.out(dim('  Press Ctrl+C when you are done.\n', tty));

  const release = deps.onInterrupt(() => server.stop());
  const reason = await server.done;
  release();
  deps.out(
    reason === 'all-saved' ? '\nAll cards saved. Stopped sharing.' : reason === 'idle' ? '\nNo activity for 10 minutes. Stopped sharing.' : '\nStopped sharing.',
  );
  return 0;
}
```

- [ ] **Step 3: Bin entry**

```ts
  story: {
    help: `Usage: tokengraph story [options]

Draws your usage as Instagram / TikTok story cards, saves them as PNG files, and can send them to
your phone: scan the QR code it shows (same Wi-Fi) and save them from the page that opens.
Reads local data only.

Options:
  --template <name>    skyline, receipt, sticker or all (default: all)
  --range <range>      today, 7d, 30d or 1y (default: today)
  --no-cost            Leave the estimated API cost off the cards
  --out <dir>          Where to save (default: ~/Downloads)
  --qr                 Send to the phone without asking
  --no-qr              Only save the files
  --no-preview         Do not draw the cards in the terminal
  --handle <name>      The name on the cards (default: your GitHub login)
`,
    options: {
      template: { type: 'string' },
      range: { type: 'string' },
      'no-cost': { type: 'boolean', default: false },
      out: { type: 'string' },
      qr: { type: 'boolean', default: false },
      'no-qr': { type: 'boolean', default: false },
      'no-preview': { type: 'boolean', default: false },
      handle: { type: 'string' },
    },
    run: (values) => {
      const options = parseStoryArgs(values);
      if (typeof options === 'string') {
        console.error(options);
        return 1;
      }
      return runStory(options);
    },
  },
```
USAGE line: `  story                Turn your usage into story cards and send them to your phone`.

- [ ] **Step 4: Run** `npx tsc --build && npx vitest run` → green. **Step 5: Commit** (`Add the story command`).

---

### Task 8: Bundle the story feature and smoke-test the package

**Files:**
- Modify: `packages/cli/package.json` (`build` script, `files`)
- Create: `scripts/smoke-story.mjs`

- [ ] **Step 1: Build script and files**

`packages/cli/package.json`:
- `"files": ["bundle", "assets"]`
- `"build": "tsc --build && esbuild dist/bin.js --bundle --platform=node --format=esm --target=node22 --define:process.env.NODE_ENV=\\\"production\\\" --outfile=bundle/bin.js --log-level=warning"` — if esbuild cannot bundle an ESM dependency that uses `require` (e.g. inside satori), add `--banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"`.

- [ ] **Step 2: Smoke script** — `scripts/smoke-story.mjs`:

```js
// Runs the packed bundle's story command in a temp home and output folder and checks the PNGs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tg-smoke-home-'));
const out = mkdtempSync(join(tmpdir(), 'tg-smoke-out-'));
execFileSync(process.execPath, ['packages/cli/bundle/bin.js', 'story', '--no-qr', '--no-preview', '--out', out, '--handle', 'smoke'], {
  env: { ...process.env, TOKENGRAPH_HOME: home },
  stdio: 'inherit',
});
const files = readdirSync(out).filter((name) => name.endsWith('.png'));
if (files.length !== 3) throw new Error(`expected 3 PNGs, got ${files.join(', ')}`);
for (const file of files) {
  const bytes = readFileSync(join(out, file));
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
}
console.log(`smoke ok: ${files.join(', ')}`);
```
Root `package.json` script: `"smoke": "npm run build -w tokengraph && node scripts/smoke-story.mjs"`.

- [ ] **Step 3: Run**

```bash
npm run smoke
cd packages/cli && npm pack --dry-run 2>&1 | tail -15 && cd ../..
```
Expected: `smoke ok`; the tarball lists `bundle/bin.js`, `assets/resvg.wasm`, `assets/fonts/*`, unpacked size under 6 MB; `package.json` has no `dependencies`.

- [ ] **Step 4: Commit** (`Bundle the story feature and smoke-test the package`).
