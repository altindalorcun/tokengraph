import { brandPaint, type BrandLogoArt } from './agent-logos.js';
import { PLEX_ADVANCES } from './font-metrics.js';
import {
  DISPLAY_SURFACES,
  FAMILY_RAMPS,
  FAMILY_RAMPS_LIGHT,
  cellColor,
  legendRamp,
  type ColorMode,
  type DisplaySurface,
  type Theme,
} from './graph-colors.js';
import { computeGraphStats, type GraphStats } from './graph-stats.js';
import { computeThresholds, levelFor, type Level } from './levels.js';
import { FAMILY_LABELS, FAMILY_LOGOS, MODEL_FAMILIES, type ModelFamily } from './model-makers.js';

export interface GraphDay {
  date: string;
  weighted: number;
  /** The model family that burned the most tokens that day. Only read in per-model colour mode. */
  topFamily?: ModelFamily | null;
}

export type { ColorMode, ModelFamily, Theme };

export interface RenderOptions {
  /** Last day shown; the grid ends on this day's week. */
  endDate: string;
  theme?: Theme;
  colorMode?: ColorMode;
  /** The narrow variant: header and grid only, no labels or legends. */
  compact?: boolean;
  /**
   * Replaces the big total with a muted "—" and this text, for a graph with nothing to count
   * ("No tokens synced yet"). Sits in the same header position as the total.
   */
  title?: string;
  /**
   * `@font-face` CSS for IBM Plex Sans, inlined in a `<style>`. Core carries no font bytes: a
   * caller that wants the font to load inside an `<img>` (a `data:` URI) passes it here. Without
   * it the text falls back to the system sans stack.
   */
  fontFaceCss?: string;
}

interface Layout {
  width: number;
  pad: number;
  /** Space above the header. */
  top: number;
  cell: number;
  gap: number;
  cellRadius: number;
  totalSize: number;
  captionSize: number;
  metaSize: number;
  /** Space between the header and whatever follows it. */
  headerGap: number;
  /** Labels, the stats strip, the hue key and the footer: the full variant only. */
  showLabels: boolean;
  labelSize: number;
  dayLabelWidth: number;
  dayLabelGap: number;
}

/** Corner rule: 17px cells get 4px corners, 13px get 3.5, smaller get 2. */
function cellRadiusFor(cell: number): number {
  return cell >= 16 ? 4 : cell >= 13 ? 3.5 : 2;
}

/**
 * Designed at 900px because GitHub shows README images at most ~830px wide: the 11px labels land
 * near 10px on screen. The proportions are scaled to that width rather than copied from another size.
 */
const FULL: Layout = {
  width: 900,
  pad: 20,
  top: 26,
  cell: 13,
  gap: 3,
  cellRadius: cellRadiusFor(13),
  totalSize: 46,
  captionSize: 14,
  metaSize: 12.5,
  headerGap: 20,
  showLabels: true,
  labelSize: 11,
  dayLabelWidth: 26,
  dayLabelGap: 5,
};

const COMPACT: Layout = {
  ...FULL,
  width: 560,
  top: 20,
  cell: 8,
  gap: 2,
  cellRadius: cellRadiusFor(8),
  totalSize: 28,
  captionSize: 12,
  metaSize: 11,
  headerGap: 16,
  showLabels: false,
  dayLabelWidth: 0,
  dayLabelGap: 0,
};

export const WEEKS = 52;
const DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Plex first; the stack after it is what shows when the inlined font cannot load. */
const FONT = "'IBM Plex Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/** Width of a glyph the table does not cover, as a fraction of the font size. */
const FALLBACK_ADVANCE = 0.56;

/** Laid-out width of `text`, from IBM Plex Sans advance widths. Only used to place things by hand. */
function textWidth(text: string, fontSize: number, weight: 400 | 500 = 400, tracking = 0): number {
  const table = PLEX_ADVANCES[weight];
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const em = code >= 0x20 && code <= 0x7e ? table.ascii[code - 0x20]! : (table.extra[ch] ?? FALLBACK_ADVANCE);
    width += em * fontSize + tracking;
  }
  return width;
}

function parseKey(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function toKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shift(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Rounds to at most two decimals so hand-laid coordinates do not print as long floats. */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** Grouped digits, the way the embed's heading shows a year's total. Locale-independent. */
export function formatTokensExact(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Grouped digits with cents, locale-independent for the same reason as formatTokensExact. */
export function formatDollars(value: number): string {
  const [whole, cents] = value.toFixed(2).split('.');
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

function text(
  content: string,
  x: number,
  y: number,
  options: {
    size: number;
    fill: string;
    weight?: 400 | 500;
    anchor?: 'start' | 'middle' | 'end';
    tracking?: number;
    opacity?: number;
  },
): string {
  const anchor = options.anchor && options.anchor !== 'start' ? ` text-anchor="${options.anchor}"` : '';
  const tracking = options.tracking ? ` letter-spacing="${n(options.tracking)}"` : '';
  const opacity = options.opacity !== undefined ? ` fill-opacity="${options.opacity}"` : '';
  return (
    `<text x="${n(x)}" y="${n(y)}" font-size="${options.size}" font-weight="${options.weight ?? 400}" ` +
    `fill="${options.fill}"${opacity}${anchor}${tracking}>${escapeXml(content)}</text>`
  );
}

function swatch(x: number, y: number, size: number, radius: number, fill: string): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${size}" height="${size}" rx="${radius}" fill="${fill}"/>`;
}

/**
 * The display: its surface, hairline ring and inset top shadow, on a card the size of the image.
 * No bezel, the README page is the frame.
 */
function card(
  layout: Layout,
  height: number,
  surface: DisplaySurface,
  body: string,
  label: string,
  fontFaceCss: string | undefined,
): string {
  const { width } = layout;
  const radius = 12;
  const style = fontFaceCss ? `<style>${fontFaceCss}</style>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}" font-family="${FONT}">` +
    style +
    `<defs><clipPath id="tg-clip"><rect width="${width}" height="${height}" rx="${radius}"/></clipPath>` +
    `<linearGradient id="tg-shade" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${surface.shade}"/><stop offset="1" stop-color="${surface.shade}" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<rect width="${width}" height="${height}" rx="${radius}" fill="${surface.background}"/>` +
    `<g clip-path="url(#tg-clip)"><rect width="${width}" height="3" fill="url(#tg-shade)"/></g>` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius - 0.5}" fill="none" stroke="${surface.ring}"/>` +
    body +
    `</svg>`
  );
}

/** One legend row item: a swatch, the family's mark (when it has one), then its name. */
interface LegendEntry {
  family: ModelFamily;
  name: string;
  logo: BrandLogoArt | undefined;
}

const LEGEND_SWATCH = 11;
const LEGEND_LOGO = 14;
const LEGEND_ROW_GAP = 8;
const LEGEND_ITEM_GAP = 22;
const LEGEND_ROW = 16;

/** The families that topped at least one drawn day with usage, in family order. */
export function gridFamilies(grid: GraphGrid): ModelFamily[] {
  const present = new Set<ModelFamily>();
  for (const column of grid.columns) {
    for (const cell of column) {
      if (cell && cell.weighted > 0 && cell.topFamily) present.add(cell.topFamily);
    }
  }
  return MODEL_FAMILIES.filter((family) => present.has(family));
}

function legendEntries(grid: GraphGrid): LegendEntry[] {
  return gridFamilies(grid).map((family) => ({
    family,
    name: FAMILY_LABELS[family],
    logo: FAMILY_LOGOS[family],
  }));
}

function entryWidth(entry: LegendEntry, size: number): number {
  return LEGEND_SWATCH + 8 + (entry.logo ? LEGEND_LOGO + 6 : 0) + textWidth(entry.name, size, 500);
}

/** Wraps the entries into rows no wider than `available`. */
function legendRows(entries: LegendEntry[], size: number, available: number): LegendEntry[][] {
  const rows: LegendEntry[][] = [];
  let used = 0;
  for (const entry of entries) {
    const width = entryWidth(entry, size);
    if (rows.length === 0 || used + LEGEND_ITEM_GAP + width > available) {
      rows.push([entry]);
      used = width;
    } else {
      rows[rows.length - 1]!.push(entry);
      used += LEGEND_ITEM_GAP + width;
    }
  }
  return rows;
}

/**
 * One brand mark at (x, y), LEGEND_LOGO square. Gradient ids carry `idPrefix`, unique per logo
 * within the SVG; monochrome (`ink`) paths take the theme's display ink.
 */
function brandLogo(art: BrandLogoArt, idPrefix: string, x: number, y: number, ink: string): string {
  const defs = (art.gradients ?? [])
    .map((gradient) => {
      const attrs = Object.entries(gradient.attrs)
        .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
        .join('');
      const stops = gradient.stops
        .map(
          (stop) =>
            `<stop${stop.offset !== undefined ? ` offset="${escapeXml(stop.offset)}"` : ''} stop-color="${escapeXml(stop.color)}"` +
            `${stop.opacity !== undefined ? ` stop-opacity="${escapeXml(stop.opacity)}"` : ''}/>`,
        )
        .join('');
      return `<linearGradient id="${idPrefix}${gradient.id}"${attrs}>${stops}</linearGradient>`;
    })
    .join('');
  const paths = art.paths
    .map((path) => `<path d="${path.d}" fill="${brandPaint(path.fill, idPrefix, ink)}"${path.evenodd ? ' fill-rule="evenodd"' : ''}/>`)
    .join('');
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(LEGEND_LOGO / 24)})">${defs ? `<defs>${defs}</defs>` : ''}${paths}</g>`;
}

/** The hue key, per-model mode only (hue means nothing when every cell is one red). Left-aligned. */
function hueLegend(
  rows: LegendEntry[][],
  layout: Layout,
  surface: DisplaySurface,
  theme: Theme,
  top: number,
): string {
  const ramps = theme === 'light' ? FAMILY_RAMPS_LIGHT : FAMILY_RAMPS;
  const parts: string[] = [];
  let logoCount = 0;
  rows.forEach((row, rowIndex) => {
    const y = top + rowIndex * (LEGEND_ROW + LEGEND_ROW_GAP);
    let x = layout.pad;
    for (const entry of row) {
      parts.push(swatch(x, y + (LEGEND_ROW - LEGEND_SWATCH) / 2, LEGEND_SWATCH, 3, ramps[entry.family][4]));
      x += LEGEND_SWATCH + 8;
      if (entry.logo) {
        parts.push(brandLogo(entry.logo, `lg${logoCount++}-`, x, y + (LEGEND_ROW - LEGEND_LOGO) / 2, surface.ink));
        x += LEGEND_LOGO + 6;
      }
      parts.push(text(entry.name, x, y + LEGEND_ROW / 2 + layout.labelSize * 0.36 + 1, { size: 13, fill: surface.muted, weight: 500 }));
      x += textWidth(entry.name, 13, 500) + LEGEND_ITEM_GAP;
    }
  });
  return parts.join('');
}

/** Less -> More, right-aligned, with swatches the same colours as the cells. */
function intensityLegend(layout: Layout, surface: DisplaySurface, theme: Theme, colorMode: ColorMode, y: number): string {
  const size = layout.labelSize;
  // The scale's boxes are the graph's own: same size, same gap.
  const swatchSize = layout.cell;
  const inner = layout.gap;
  const levels = [0, 1, 2, 3, 4, 5] as const;
  const moreW = textWidth('More', size);
  const right = layout.width - layout.pad;
  const swatchesEnd = right - moreW - 6;
  const swatchesStart = swatchesEnd - (levels.length * swatchSize + (levels.length - 1) * inner);
  const baseline = y + swatchSize / 2 + size * 0.36;

  const parts = [text('Less', swatchesStart - 6, baseline, { size, fill: surface.muted, anchor: 'end' })];
  for (const level of levels) {
    const fill = level === 0 ? surface.empty : legendRamp(theme, colorMode)[level]!;
    parts.push(swatch(swatchesStart + level * (swatchSize + inner), y, swatchSize, layout.cellRadius, fill));
  }
  parts.push(text('More', right, baseline, { size, fill: surface.muted, anchor: 'end' }));
  return parts.join('');
}

export interface GridCell {
  date: string;
  weighted: number;
  level: Level;
  topFamily: ModelFamily | null;
}

export interface GraphGrid {
  /** 52 columns of 7 days, Sunday first. A slot is null when that day falls after the end date. */
  columns: (GridCell | null)[][];
  /** Month labels, each with the column it starts on. */
  months: { label: string; column: number }[];
  total: number;
  activeDays: number;
}

/**
 * The grid both renderers draw. Keeping the week maths, the quantile levels and the month marks
 * in one place is the only way the React grid and the SVG endpoint stay in step.
 */
export function buildGraphGrid(days: readonly GraphDay[], endDate: string): GraphGrid {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const thresholds = computeThresholds(days.map((day) => day.weighted));

  const end = parseKey(endDate);
  // Pad the final column out to Saturday so every column holds a full week.
  const gridEnd = shift(end, 6 - end.getUTCDay());
  const gridStart = shift(gridEnd, -(WEEKS * DAYS - 1));

  const columns: (GridCell | null)[][] = [];
  const months: { label: string; column: number }[] = [];
  let previousMonth = -1;
  let total = 0;
  let activeDays = 0;

  for (let week = 0; week < WEEKS; week += 1) {
    const column: (GridCell | null)[] = [];
    for (let weekday = 0; weekday < DAYS; weekday += 1) {
      const current = shift(gridStart, week * DAYS + weekday);
      if (current > end) {
        column.push(null);
        continue;
      }
      const key = toKey(current);
      const day = byDate.get(key);
      const weighted = day?.weighted ?? 0;
      if (weighted > 0) {
        total += weighted;
        activeDays += 1;
      }
      column.push({
        date: key,
        weighted,
        level: levelFor(weighted, thresholds),
        topFamily: day?.topFamily ?? null,
      });

      if (weekday === 0) {
        const month = current.getUTCMonth();
        if (month !== previousMonth) {
          previousMonth = month;
          months.push({ label: MONTHS[month]!, column: week });
        }
      }
    }
    columns.push(column);
  }

  return { columns, months, total, activeDays };
}

/** A cell's tooltip. The graph must never be colour alone. */
export function cellTitle(cell: GridCell): string {
  return cell.weighted > 0 ? `${formatTokens(cell.weighted)} tokens on ${cell.date}` : `No tokens on ${cell.date}`;
}

/** Every other month keeps the row legible; each label still sits on its own column. */
export function visibleMonths(months: readonly { label: string; column: number }[]) {
  return months.filter((_, index) => index % 2 === 0);
}

/**
 * Chrome colours that belong to the graph card only (the shared display surfaces also serve the
 * terminal and story cards). The light ring is deliberately stronger than the dark one: on a white
 * README page a 6% hairline vanishes.
 */
interface Chrome {
  ring: string;
  /** The stats strip's panel. */
  soft: string;
  /** Hairlines inside the strip. */
  hair: string;
  /** Month dividers through the grid. */
  divider: string;
  /** The corner glow: neutral, never tinted by a family (a tint would differ per user). */
  glow: string;
  glowOpacity: number;
}

const CHROME: Record<Theme, Chrome> = {
  dark: {
    ring: 'rgb(255 255 255 / 0.08)',
    soft: 'rgb(255 255 255 / 0.04)',
    hair: 'rgb(255 255 255 / 0.08)',
    divider: 'rgb(255 255 255 / 0.075)',
    glow: '#ffffff',
    glowOpacity: 0.06,
  },
  light: {
    ring: 'rgb(31 35 40 / 0.14)',
    soft: 'rgb(31 35 40 / 0.045)',
    hair: 'rgb(31 35 40 / 0.09)',
    divider: 'rgb(31 35 40 / 0.10)',
    glow: '#1b1f24',
    glowOpacity: 0.035,
  },
};

/**
 * The README graph's motion. The default state (outside any media query) is the finished picture,
 * so a renderer that never runs CSS animation, or a reader who prefers reduced motion, sees the
 * whole graph at once. Animation exists only inside `no-preference`: the header and strip fade up,
 * the grid appears column by column (~1.6s), then today's cell pulses gently.
 */
const ANIMATION_CSS =
  '.halo{opacity:0;transform-box:fill-box;transform-origin:center}.ring{opacity:.7}' +
  '@media (prefers-reduced-motion:no-preference){' +
  '@keyframes tgin{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}' +
  '@keyframes tgpulse{0%{opacity:.6;transform:scale(1)}100%{opacity:0;transform:scale(2.3)}}' +
  '@keyframes tgring{0%,100%{opacity:.35}50%{opacity:.95}}' +
  '.h{animation:tgin .7s cubic-bezier(.22,.8,.3,1) both}' +
  '.c{animation:tgin .55s cubic-bezier(.22,.8,.3,1) both}' +
  Array.from({ length: WEEKS }, (_, i) => `.d${i}{animation-delay:${(0.3 + i * 0.016).toFixed(3)}s}`).join('') +
  '.halo{animation:tgpulse 2.8s cubic-bezier(.2,.6,.3,1) 1.9s infinite}' +
  '.ring{animation:tgring 2.8s ease-in-out 1.9s infinite}}';

/** The graph card: surface, neutral corner glow, hairline ring, then the body. */
function graphFrame(
  layout: Layout,
  height: number,
  theme: Theme,
  body: string,
  label: string,
  fontFaceCss: string | undefined,
): string {
  const { width } = layout;
  const surface = DISPLAY_SURFACES[theme];
  const chrome = CHROME[theme];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}" font-family="${FONT}">` +
    `<style>${fontFaceCss ?? ''}${ANIMATION_CSS}</style>` +
    `<defs><radialGradient id="tg-glow" cx="0" cy="0" r="560" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${chrome.glow}" stop-opacity="${chrome.glowOpacity}"/>` +
    `<stop offset="1" stop-color="${chrome.glow}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${width}" height="${height}" rx="14" fill="${surface.background}"/>` +
    `<rect width="${width}" height="${height}" rx="14" fill="url(#tg-glow)"/>` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="13.5" fill="none" stroke="${chrome.ring}"/>` +
    body +
    `</svg>`
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function monthDay(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

function monthYear(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** "Oct 2025 to Oct 2026", or empty for a grid with no days. */
function rangeLabel(stats: GraphStats): string {
  return stats.firstDate && stats.lastDate ? `${monthYear(stats.firstDate)} to ${monthYear(stats.lastDate)}` : '';
}

const STRIP_HEIGHT = 60;
/**
 * Widths of the strip's first four columns; the fifth (family name and day count) takes the rest.
 * Today's figure is short, so the streak beside it gets the room for "362 days · best 362".
 */
const STRIP_COLUMNS = [136, 160, 148, 148];
const STRIP_INSET = 18;

interface StripItem {
  label: string;
  value: string;
  sub: string;
  /** A family swatch before the value. */
  dot?: string;
}

function stripItems(stats: GraphStats, colorMode: ColorMode, theme: Theme): StripItem[] {
  const dash = (value: string, sub: string): Pick<StripItem, 'value' | 'sub'> =>
    stats.activeDays === 0 ? { value: '—', sub: '' } : { value, sub };
  const ramps = theme === 'light' ? FAMILY_RAMPS_LIGHT : FAMILY_RAMPS;
  const fifth: StripItem =
    colorMode === 'per-model'
      ? stats.topFamily
        ? {
            label: 'TOP FAMILY',
            value: FAMILY_LABELS[stats.topFamily.family],
            sub: `led ${plural(stats.topFamily.days, 'day')}`,
            dot: ramps[stats.topFamily.family][4],
          }
        : { label: 'TOP FAMILY', value: '—', sub: '' }
      : { label: 'AVG ACTIVE DAY', ...dash(formatTokens(stats.total / Math.max(stats.activeDays, 1)), 'tokens') };
  return [
    { label: 'TODAY', ...dash(formatTokens(stats.today), 'tokens') },
    {
      label: 'STREAK',
      ...dash(String(stats.currentStreak), `${stats.currentStreak === 1 ? 'day' : 'days'} · best ${stats.longestStreak}`),
    },
    {
      label: 'BEST DAY',
      ...(stats.bestDay ? { value: formatTokens(stats.bestDay.weighted), sub: monthDay(stats.bestDay.date) } : { value: '—', sub: '' }),
    },
    { label: 'ACTIVE DAYS', value: String(stats.activeDays), sub: `of ${stats.windowDays}` },
    fifth,
  ];
}

/** The five-figure panel under the header. Daily totals and one family name, nothing else. */
function statsStrip(
  layout: Layout,
  stats: GraphStats,
  colorMode: ColorMode,
  theme: Theme,
  y: number,
): string {
  const surface = DISPLAY_SURFACES[theme];
  const chrome = CHROME[theme];
  const { pad } = layout;
  const innerWidth = layout.width - 2 * pad;
  const parts = [
    `<rect x="${pad}" y="${n(y)}" width="${innerWidth}" height="${STRIP_HEIGHT}" rx="10" fill="${chrome.soft}"/>`,
    `<rect x="${pad + 0.5}" y="${n(y + 0.5)}" width="${innerWidth - 1}" height="${STRIP_HEIGHT - 1}" rx="9.5" fill="none" stroke="${chrome.hair}"/>`,
  ];
  let left = pad;
  stripItems(stats, colorMode, theme).forEach((item, index) => {
    if (index > 0) left += STRIP_COLUMNS[index - 1]!;
    const x = left + STRIP_INSET;
    if (index > 0) parts.push(`<path d="M${left} ${n(y + 14)}V${n(y + STRIP_HEIGHT - 14)}" stroke="${chrome.hair}"/>`);
    parts.push(text(item.label, x, y + 22, { size: 10, fill: surface.muted, weight: 500, tracking: 0.9 }));
    let valueX = x;
    if (item.dot) {
      parts.push(`<rect x="${n(x)}" y="${n(y + 34)}" width="9" height="9" rx="3" fill="${item.dot}"/>`);
      valueX += 15;
    }
    parts.push(text(item.value, valueX, y + 43, { size: 19, fill: surface.ink, weight: 500, tracking: -0.2 }));
    if (item.sub) {
      parts.push(text(item.sub, valueX + textWidth(item.value, 19, 500, -0.2) + 6, y + 43, { size: 12.5, fill: surface.muted }));
    }
  });
  return parts.join('');
}

/** Month labels that fit: a first month cut short by the window start would collide with the next. */
function labelledMonths(months: GraphGrid['months']): GraphGrid['months'] {
  return months.filter((mark, index) => !(index === 0 && months[1] && months[1].column - mark.column < 3));
}

interface Heatmap {
  svg: string;
  bottom: number;
}

/**
 * Month labels with hairline dividers, weekday labels (full variant) and the cells, one animated
 * group per week. Today's cell gets a ring, and a halo when it has tokens.
 */
function heatmap(
  grid: GraphGrid,
  layout: Layout,
  theme: Theme,
  colorMode: ColorMode,
  endDate: string,
  y: number,
): Heatmap {
  const surface = DISPLAY_SURFACES[theme];
  const chrome = CHROME[theme];
  const pitch = layout.cell + layout.gap;
  const gridX = layout.pad + layout.dayLabelWidth + layout.dayLabelGap;
  const gridY = layout.showLabels ? y + 19 : y;
  const bottom = gridY + 7 * pitch - layout.gap;
  const parts: string[] = [];

  if (layout.showLabels) {
    for (const mark of labelledMonths(grid.months)) {
      parts.push(text(mark.label, gridX + mark.column * pitch, y + 9.5, { size: layout.labelSize, fill: surface.muted }));
    }
    for (const [row, label] of [
      [1, 'Mon'],
      [3, 'Wed'],
      [5, 'Fri'],
    ] as const) {
      parts.push(
        text(label, layout.pad, gridY + row * pitch + layout.cell / 2 + layout.labelSize * 0.36, {
          size: layout.labelSize,
          fill: surface.muted,
        }),
      );
    }
    for (const mark of grid.months.slice(1)) {
      const x = gridX + mark.column * pitch - layout.gap / 2;
      parts.push(`<path d="M${n(x)} ${n(y + 1)}V${n(bottom)}" stroke="${chrome.divider}"/>`);
    }
  }

  let today: { x: number; y: number; fill: string; active: boolean } | null = null;
  grid.columns.forEach((column, week) => {
    const rects = column
      .map((cell, weekday) => {
        if (!cell) return '';
        const fill = cellColor(cell.level, { colorMode, theme, family: cell.topFamily, empty: surface.empty });
        const x = gridX + week * pitch;
        const cy = gridY + weekday * pitch;
        if (cell.date === endDate) today = { x, y: cy, fill, active: cell.weighted > 0 };
        return (
          `<rect x="${n(x)}" y="${n(cy)}" width="${layout.cell}" height="${layout.cell}" rx="${layout.cellRadius}" fill="${fill}">` +
          `<title>${escapeXml(cellTitle(cell))}</title></rect>`
        );
      })
      .join('');
    parts.push(`<g class="c d${week}">${rects}</g>`);
  });

  if (today) {
    const { x, y: cy, fill, active } = today;
    const reach = layout.cell >= 13 ? 1.5 : 1;
    if (active) {
      parts.push(
        `<rect class="halo" x="${n(x)}" y="${n(cy)}" width="${layout.cell}" height="${layout.cell}" rx="${layout.cellRadius}" fill="${fill}"/>`,
      );
    }
    // A day without tokens still gets its ring, dimmer, so the grid always shows where today is.
    parts.push(
      `<rect class="ring" x="${n(x - reach)}" y="${n(cy - reach)}" width="${layout.cell + 2 * reach}" height="${layout.cell + 2 * reach}" ` +
        `rx="${layout.cellRadius + 1.5}" fill="none" stroke="${surface.ink}" stroke-width="${layout.cell >= 13 ? 1.25 : 1}"` +
        `${active ? '' : ' stroke-opacity="0.6"'}/>`,
    );
  }
  return { svg: parts.join(''), bottom };
}

export function renderGraphSvg(days: readonly GraphDay[], options: RenderOptions): string {
  const layout = options.compact ? COMPACT : FULL;
  const theme = options.theme ?? 'dark';
  const colorMode = options.colorMode ?? 'single';
  const surface = DISPLAY_SURFACES[theme];
  const grid = buildGraphGrid(days, options.endDate);
  const stats = computeGraphStats(grid);
  const { pad } = layout;

  // Header: the big total, its caption on the same baseline, the date range (active days when compact) at the right.
  const empty = grid.total === 0 || options.title !== undefined;
  const baseline = layout.top + layout.totalSize * 0.8;
  const tracking = -0.025 * layout.totalSize;
  const total = options.title !== undefined ? '—' : formatTokens(grid.total);
  const caption = options.title ?? (empty ? 'No tokens yet, last 12 months' : 'tokens, last 12 months');
  const totalWidth = textWidth(total, layout.totalSize, 500, tracking);
  const meta = layout.showLabels ? rangeLabel(stats) : plural(stats.activeDays, 'active day');

  const header =
    text(total, pad, baseline, { size: layout.totalSize, fill: empty ? surface.muted : surface.ink, weight: 500, tracking }) +
    text(caption, pad + totalWidth + layout.totalSize * 0.3, baseline, { size: layout.captionSize, fill: surface.muted }) +
    (meta ? text(meta, layout.width - pad, baseline, { size: layout.metaSize, fill: surface.muted, anchor: 'end' }) : '');
  const parts: string[] = [`<g class="h">${header}</g>`];
  let y = layout.top + layout.totalSize + layout.headerGap;

  if (layout.showLabels) {
    parts.push(`<g class="h">${statsStrip(layout, stats, colorMode, theme, y)}</g>`);
    y += STRIP_HEIGHT + 22;
    if (colorMode === 'per-model') {
      const rows = legendRows(legendEntries(grid), 13, layout.width - 2 * pad);
      if (rows.length > 0) {
        parts.push(hueLegend(rows, layout, surface, theme, y));
        y += rows.length * LEGEND_ROW + (rows.length - 1) * LEGEND_ROW_GAP + 20;
      }
    }
  }

  const map = heatmap(grid, layout, theme, colorMode, options.endDate, y);
  parts.push(map.svg);

  let height: number;
  if (layout.showLabels) {
    const footerY = map.bottom + 20;
    parts.push(
      text('tokengraph', pad, footerY + 10, { size: 11, fill: surface.muted, weight: 500, tracking: 0.4, opacity: 0.8 }),
      intensityLegend(layout, surface, theme, colorMode, footerY),
    );
    height = Math.round(footerY + layout.cell + 22);
  } else {
    height = Math.round(map.bottom + pad);
  }

  const label =
    `Token usage graph, ${formatTokens(grid.total)} weighted tokens over ${plural(grid.activeDays, 'active day')}` +
    (grid.activeDays > 0 ? `, current streak ${plural(stats.currentStreak, 'day')}` : '');
  return graphFrame(layout, height, theme, parts.join(''), label, options.fontFaceCss);
}

/**
 * The card served when there is no graph to show: a private profile, or a handle nobody has
 * claimed. A README should show a readable message rather than a broken image.
 */
export function renderNoticeSvg(
  message: string,
  options: { theme?: Theme; compact?: boolean; fontFaceCss?: string } = {},
): string {
  const layout = options.compact ? COMPACT : FULL;
  const surface = DISPLAY_SURFACES[options.theme ?? 'dark'];
  const height = options.compact ? 120 : 200;
  const centreX = layout.width / 2;
  const centreY = height / 2;

  const lock =
    `<g stroke="${surface.muted}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" ` +
    `transform="translate(${n(centreX - 13)} ${n(centreY - 36)}) scale(1.0833)">` +
    `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></g>`;

  const body = lock + text(message, centreX, centreY + 20, { size: 15, fill: surface.ink, weight: 500, anchor: 'middle' });
  return card(layout, height, surface, body, message, options.fontFaceCss);
}

