// Builds landing.json: everything the promo site needs to draw its interactive hero graph without
// importing any tokengraph code. Pure: `core` is passed in (the @tokengraph/core module namespace),
// so the script can hand it the built dist and the test can hand it the sources.

const SCHEMA = 1;
const RECENT_DAYS = 14;
const TOP_MODELS = 4;
/** Monochrome marks take the site's ink colour when it defines `--tg-ink` (black on light, white on dark), else the text colour. */
const INK = 'var(--tg-ink, currentColor)';
const AGENT_LABELS = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  cline: 'Cline',
  opencode: 'OpenCode',
};

function shiftDate(date, days) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** One ramp as `--graph-<hue>-<level>` declarations; an idle day (level 0) takes the surface's own empty colour. */
function ramp(hue, colors, empty) {
  return colors.map((color, level) => `--graph-${hue}-${level}:${level === 0 ? empty : color};`).join('');
}

function declarations(core, ramps, single, neutral, empty) {
  return ramp('single', single, empty) + ramp('neutral', neutral, empty) + core.MODEL_FAMILIES.map((family) => ramp(family, ramps[family], empty)).join('');
}

/** Light is the default; dark applies when chosen, or when the system asks and nothing overrides it. */
export function paletteCss(core) {
  const { DISPLAY_SURFACES: surfaces } = core;
  const light = declarations(core, core.FAMILY_RAMPS_LIGHT, core.GRAPH_RAMP_LIGHT, core.NEUTRAL_RAMP_LIGHT, surfaces.light.empty);
  const dark = declarations(core, core.FAMILY_RAMPS, core.GRAPH_RAMP_DARK, core.NEUTRAL_RAMP_DARK, surfaces.dark.empty);
  return `:root{${light}}@media (prefers-color-scheme:dark){:root:not([data-theme='light']){${dark}}}:root[data-theme='dark']{${dark}}`;
}

/** A brand mark as inline SVG markup. Monochrome marks follow `--tg-ink`, else the text colour. */
export function logoSvg(core, art, idPrefix) {
  const gradients = (art.gradients ?? [])
    .map((gradient) => {
      const attrs = Object.entries(gradient.attrs)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
      const stops = gradient.stops
        .map((stop) => `<stop${stop.offset ? ` offset="${stop.offset}"` : ''} stop-color="${stop.color}"${stop.opacity ? ` stop-opacity="${stop.opacity}"` : ''}/>`)
        .join('');
      return `<linearGradient id="${idPrefix}${gradient.id}" ${attrs}>${stops}</linearGradient>`;
    })
    .join('');
  const paths = art.paths
    .map((path) => `<path d="${path.d}" style="fill:${core.brandPaint(path.fill, idPrefix, INK)}"${path.evenodd ? ' fill-rule="evenodd"' : ''}/>`)
    .join('');
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${gradients ? `<defs>${gradients}</defs>` : ''}${paths}</svg>`;
}

/** Each model family's part of all weighted tokens, heaviest first (ties by family name). */
export function familyShares(core, modelRows) {
  const counts = new Map();
  for (const row of modelRows) {
    const family = core.modelFamily(row.model);
    counts.set(family, core.addCounts(counts.get(family) ?? core.emptyCounts(), row));
  }
  const weights = [...counts].map(([family, sum]) => ({ family, weighted: core.weightedTokens(sum) }));
  const total = weights.reduce((sum, entry) => sum + entry.weighted, 0);
  if (total <= 0) return [];
  return weights
    .map((entry) => ({ family: entry.family, label: core.FAMILY_LABELS[entry.family], weighted: entry.weighted, share: entry.weighted / total }))
    .sort((a, b) => b.weighted - a.weighted || a.family.localeCompare(b.family));
}

/** The last `count` calendar days up to `endDate`, oldest first; a day with no usage is a zero bar. */
export function recentBars(days, endDate, count = RECENT_DAYS) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  return Array.from({ length: count }, (_, index) => {
    const date = shiftDate(endDate, index - (count - 1));
    const day = byDate.get(date);
    return { date, weighted: day?.weighted ?? 0, family: day?.topFamily ?? null };
  });
}

/** Per date: models merged by display label, top four by weight, each with its share of the whole day. */
export function dayModels(core, modelRows, dates) {
  const wanted = new Set(dates);
  const byDate = new Map();
  for (const row of modelRows) {
    if (!wanted.has(row.date)) continue;
    const label = core.modelLabel(row.model);
    const models = byDate.get(row.date) ?? new Map();
    const entry = models.get(label) ?? { family: core.modelFamily(row.model), counts: core.emptyCounts() };
    entry.counts = core.addCounts(entry.counts, row);
    models.set(label, entry);
    byDate.set(row.date, models);
  }
  const result = {};
  for (const date of [...byDate.keys()].sort()) {
    const entries = [...byDate.get(date)]
      .map(([label, entry]) => ({ label, family: entry.family, weighted: core.weightedTokens(entry.counts) }))
      .filter((entry) => entry.weighted > 0)
      .sort((a, b) => b.weighted - a.weighted || a.label.localeCompare(b.label));
    const total = entries.reduce((sum, entry) => sum + entry.weighted, 0);
    if (total <= 0) continue;
    result[date] = entries.slice(0, TOP_MODELS).map((entry) => ({ ...entry, share: entry.weighted / total }));
  }
  return result;
}

export function buildLanding(core, { referenceDate, handle }) {
  const now = new Date(`${referenceDate}T12:00:00Z`);
  const { days, modelRows } = core.demoUsage(now);
  const endDate = core.graphEndDate(referenceDate, days.map((day) => day.date));
  const grid = core.buildGraphGrid(days, endDate);
  const cells = grid.columns.flat().filter((cell) => cell !== null);
  const best = cells.reduce((top, cell) => (cell.weighted > (top?.weighted ?? 0) ? cell : top), null);
  const stats = core.summarizeStats(days, endDate);

  const families = {};
  for (const family of core.MODEL_FAMILIES) {
    const art = core.FAMILY_LOGOS[family];
    if (art) families[family] = logoSvg(core, art, `tgf-${family}-`);
  }
  const agents = {};
  for (const source of core.KNOWN_SOURCES) {
    const art = core.AGENT_LOGOS[source];
    if (art) agents[source] = { label: AGENT_LABELS[source] ?? core.agentName(source), svg: logoSvg(core, art, `tga-${source}-`) };
  }

  return {
    schema: SCHEMA,
    referenceDate,
    handle,
    grid,
    stats: {
      total: grid.total,
      activeDays: grid.activeDays,
      streak: stats.streak,
      best: best ? { date: best.date, weighted: best.weighted } : null,
    },
    families: familyShares(core, modelRows),
    recentBars: recentBars(days, endDate),
    dayModels: dayModels(core, modelRows, cells.filter((cell) => cell.weighted > 0).map((cell) => cell.date)),
    paletteCss: paletteCss(core),
    logos: { families, agents },
  };
}
