#!/usr/bin/env node
// Writes every sample the site and the README show, from the demo account on a fixed day:
//   node scripts/samples.mjs <outDir> [--readme]
// --readme also refreshes docs/assets/ (graph-dark.svg, graph-light.svg, story-strip.png, og.png, logo-*.svg).
// Run against built output: `npx tsc --build` first (or `npm run samples`, which builds the CLI bundle too).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import * as core from '../packages/core/dist/index.js';
import { createStoryRenderer } from '../packages/cli/dist/story/render.js';
import { STORY_CTA } from '../packages/cli/dist/story/cards/context.js';
import { qrMatrix } from '../packages/cli/dist/share/qr.js';
import { buildLanding } from './samples-landing.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE = new Date('2026-10-11T12:00:00Z');
const REFERENCE_DATE = '2026-10-11';
const REPO_URL = 'https://github.com/altindalorcun/tokengraph';
const out = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'samples');
const readme = process.argv.includes('--readme');
mkdirSync(out, { recursive: true });

// Every sample draws the demo year the story cards draw: slid so its heaviest recent day is today, so the graph's
// TODAY, the story cards and the site's numbers all agree.
const { rows: modelRows } = core.demoStoryRows(REFERENCE);
const demoDays = core.toGraphDaysByFamily(modelRows);

// 1. README graphs, exactly as `tokengraph sync` publishes them.
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
  { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', width: stripWidth, height: stripHeight } },
  ...thumbs.map((t, i) => {
    const card = h('img', { src: t.src, width: THUMB, height: t.height });
    // The sticker is a transparent PNG meant to sit on a photo; give it one, or its white type vanishes on a light page.
    const backdrop = t.template === 'sticker' ? { backgroundImage: 'linear-gradient(160deg, #3b3f4a, #15171c 60%, #2b1d16)' } : {};
    return h('div', { key: t.template, style: { display: 'flex', width: THUMB, height: t.height, marginLeft: i === 0 ? 0 : GAP, borderRadius: 24, overflow: 'hidden', ...backdrop } }, card);
  }),
);
writeFileSync(join(out, 'story-strip.png'), (await renderer.rasterize(strip, { width: stripWidth, height: stripHeight }, stripWidth)).png);

// 3. The social preview: logo, headline, the real graph, the install line. The graph is drawn from the same grid as
// the README one but without its text: resvg (the rasteriser) does not read the SVG's embedded @font-face, so
// every word here is a real element instead.
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const OG_PAD_X = 72;
const OG_BACKGROUND = '#0b0b0d';
const innerWidth = OG_WIDTH - OG_PAD_X * 2;
const [, , lockupW, lockupH] = /viewBox="([^"]+)"/.exec(core.logoLockupSvg('dark'))[1].split(' ').map(Number);
const logoHeight = 48;
const logoWidth = Math.round((lockupW / lockupH) * logoHeight);

const grid = core.buildGraphGrid(demoDays, core.graphEndDate(REFERENCE_DATE, demoDays.map((day) => day.date)));
const pitch = innerWidth / core.WEEKS;
const cell = pitch * 0.84;
const cellRadius = cell * 0.22;
const graphHeight = Math.ceil(7 * pitch);
const empty = core.DISPLAY_SURFACES.dark.empty;
const rects = grid.columns
  .flatMap((column, x) =>
    column.map((entry, y) =>
      entry
        ? `<rect x="${(x * pitch).toFixed(2)}" y="${(y * pitch).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${cellRadius.toFixed(2)}" fill="${core.cellColor(entry.level, { colorMode: 'per-model', theme: 'dark', family: entry.topFamily, empty })}"/>`
        : '',
    ),
  )
  .join('');
const ogGraph = `<svg xmlns="http://www.w3.org/2000/svg" width="${innerWidth}" height="${graphHeight}" viewBox="0 0 ${innerWidth} ${graphHeight}">${rects}</svg>`;

const sans = { fontFamily: 'Plex Sans', display: 'flex' };
const mono = { fontFamily: 'Plex Mono', display: 'flex' };
const og = h(
  'div',
  // border-box: Satori 0.55 adds padding to the height otherwise, and the install line falls off the card.
  { style: { display: 'flex', flexDirection: 'column', boxSizing: 'border-box', width: OG_WIDTH, height: OG_HEIGHT, background: OG_BACKGROUND, padding: `60px ${OG_PAD_X}px 56px`, justifyContent: 'space-between' } },
  h('img', { src: core.svgUri(core.logoLockupSvg('dark')), height: logoHeight, width: logoWidth }),
  h(
    'div',
    { style: { display: 'flex', flexDirection: 'column' } },
    h('div', { style: { ...sans, fontWeight: 600, fontSize: 68, lineHeight: 1.1, color: '#f4f4f5', letterSpacing: -1.5 } }, 'Your AI coding,'),
    h('div', { style: { ...sans, fontWeight: 600, fontSize: 68, lineHeight: 1.1, color: '#f4f4f5', letterSpacing: -1.5 } }, 'as a GitHub-style graph.'),
  ),
  h('img', { src: core.svgUri(ogGraph), width: innerWidth, height: graphHeight }),
  h(
    'div',
    { style: { display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' } },
    h('div', { style: { ...mono, fontWeight: 500, fontSize: 30, color: '#eef0f2' } }, STORY_CTA),
    h('div', { style: { ...sans, fontWeight: 400, fontSize: 24, color: '#a3aab3' } }, 'Claude Code, Codex, Cursor, Gemini CLI and 7 more'),
  ),
);
writeFileSync(join(out, 'og.png'), (await renderer.rasterize(og, { width: OG_WIDTH, height: OG_HEIGHT }, OG_WIDTH)).png);

// 4. A QR that opens the repo, for the site's story section (scanning the demo leads somewhere real).
const matrix = qrMatrix(REPO_URL);
const size = matrix.length + 8;
const modules = matrix.flatMap((row, y) => row.map((dark, x) => (dark ? `<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>` : ''))).join('');
writeFileSync(join(out, 'qr-repo.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${modules}</g></svg>\n`);

// 5. Everything the landing page draws itself.
writeFileSync(join(out, 'landing.json'), `${JSON.stringify(buildLanding(core, { referenceDate: REFERENCE_DATE, handle: core.DEMO_HANDLE }), null, 2)}\n`);

if (readme) {
  const assets = join(ROOT, 'docs/assets');
  mkdirSync(assets, { recursive: true });
  for (const name of ['graph-dark.svg', 'graph-light.svg', 'story-strip.png', 'og.png']) copyFileSync(join(out, name), join(assets, name));
  writeFileSync(join(assets, 'logo-dark.svg'), `${core.logoLockupSvg('dark')}\n`);
  writeFileSync(join(assets, 'logo-light.svg'), `${core.logoLockupSvg('light')}\n`);
}
console.log(`samples written to ${out}${readme ? ' (and docs/assets)' : ''}`);
