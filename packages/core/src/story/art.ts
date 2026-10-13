import { AGENT_LOGOS, brandPaint, type BrandLogoArt } from '../agent-logos.js';
import { MAKER_LOGOS } from '../maker-logos.js';
import { FAMILY_LOGOS, type Maker, type ModelFamily } from '../model-makers.js';

/**
 * Small SVG pieces for the story cards, as strings. The PNG renderer takes nested SVG only as an
 * image, so each piece becomes a data: URI the card drops into an <img>. Runs in the browser (the
 * cards are drawn there) as well as on the server, so nothing here may touch Node APIs.
 */

/** Base64 of a string's UTF-8 bytes, in the browser, a worker or Node alike (no Buffer). */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function svgUri(svg: string): string {
  return `data:image/svg+xml;base64,${base64(svg)}`;
}

/** Claude, OpenAI and Gemini use the agents' artwork, as the dashboard's ModelLogo does. */
const MAKER_ART: Partial<Record<Maker, BrandLogoArt>> = {
  ...MAKER_LOGOS,
  anthropic: AGENT_LOGOS['claude-code'],
  openai: AGENT_LOGOS['codex-cli'],
  google: AGENT_LOGOS['gemini-cli'],
};

/** A 24x24 brand mark; monochrome marks take `ink`. */
export function brandLogoSvg(art: BrandLogoArt, ink: string, id = 'l'): string {
  const gradients = (art.gradients ?? [])
    .map((g) => {
      const attrs = Object.entries(g.attrs)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
      const stops = g.stops
        .map((s) => `<stop${s.offset ? ` offset="${s.offset}"` : ''} stop-color="${s.color}"${s.opacity ? ` stop-opacity="${s.opacity}"` : ''}/>`)
        .join('');
      return `<linearGradient id="${id}${g.id}" ${attrs}>${stops}</linearGradient>`;
    })
    .join('');
  const paths = art.paths
    .map((p) => `<path d="${p.d}" fill="${brandPaint(p.fill, id, ink)}"${p.evenodd ? ' fill-rule="evenodd"' : ''}/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96"><defs>${gradients}</defs>${paths}</svg>`;
}

/** A maker's mark as an image source, or null for an unknown maker (the card draws a plain dot instead). */
export function makerLogoUri(maker: Maker | null, ink: string): string | null {
  const art = maker ? MAKER_ART[maker] : undefined;
  return art ? svgUri(brandLogoSvg(art, ink)) : null;
}

export function familyLogoUri(family: ModelFamily, ink: string): string | null {
  const art = FAMILY_LOGOS[family];
  return art ? svgUri(brandLogoSvg(art, ink)) : null;
}

/** Film grain: fractal noise at low opacity takes the flat, computer-made look off a gradient. */
export function grainSvg(width: number, height: number, opacity: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>` +
    `<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.4 -0.35"/></filter>` +
    `<rect width="100%" height="100%" filter="url(#n)" opacity="${opacity}"/></svg>`
  );
}

/** A torn edge for the receipt: a row of teeth `tooth` px wide, pointing up or down. */
export function zigzagSvg(width: number, tooth: number, color: string, direction: 'up' | 'down'): string {
  const depth = tooth / 2;
  const count = Math.ceil(width / tooth);
  const pts: string[] = [];
  if (direction === 'down') {
    pts.push('0,0');
    for (let i = 0; i < count; i += 1) pts.push(`${i * tooth + tooth / 2},${depth}`, `${(i + 1) * tooth},0`);
  } else {
    pts.push(`0,${depth}`);
    for (let i = 0; i < count; i += 1) pts.push(`${i * tooth + tooth / 2},0`, `${(i + 1) * tooth},${depth}`);
  }
  const close = direction === 'down' ? `${count * tooth},0` : `${count * tooth},${depth}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${depth}" viewBox="0 0 ${width} ${depth}">` +
    `<polygon points="${pts.join(' ')} ${close}" fill="${color}"/></svg>`
  );
}

/**
 * Code 128 (set B) bar and space widths, in modules, for values 0-102, then Start B (104) and Stop.
 * Each symbol is 11 modules wide; Stop is 13.
 */
const CODE128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131',
] as const;
const START_B = '211214';
const STOP = '2331112';

/** The symbol values of `text` in Code 128 set B (printable ASCII only), then its checksum. */
export function code128Values(text: string): { values: number[]; checksum: number } {
  const values = [...text].map((char) => {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error(`Code 128B cannot encode ${JSON.stringify(char)}`);
    return code - 32;
  });
  const checksum = values.reduce((sum, value, index) => sum + value * (index + 1), 104) % 103;
  return { values, checksum };
}

/** The bar/space width pattern of `text` in Code 128 set B, Start B to Stop. */
export function code128Pattern(text: string): string {
  const { values, checksum } = code128Values(text);
  return [START_B, ...values.map((value) => CODE128[value]!), CODE128[checksum]!, STOP].join('');
}

/** A Code 128 barcode as SVG, `module` px per module, bars only (the card prints the text itself). */
export function barcodeSvg(text: string, height: number, module: number, color: string): { svg: string; width: number } {
  const pattern = code128Pattern(text);
  let x = 0;
  const bars: string[] = [];
  [...pattern].forEach((digit, index) => {
    const w = Number(digit) * module;
    if (index % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`);
    x += w;
  });
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${height}" viewBox="0 0 ${x} ${height}" fill="${color}">${bars.join('')}</svg>`,
    width: x,
  };
}

/**
 * The contribution graph as plain squares, oldest week on the left: a level-coloured cell per day,
 * `empty` for an idle one, nothing for a future one. Used big and blurred-dark as a backdrop.
 */
export function heatmapSvg(
  weeks: readonly (readonly ({ level: number; family: ModelFamily | null } | null)[])[],
  cell: number,
  gap: number,
  colors: (family: ModelFamily | null, level: number) => string,
): { svg: string; width: number; height: number } {
  const step = cell + gap;
  const width = weeks.length * step - gap;
  const height = 7 * step - gap;
  const rects = weeks.flatMap((column, week) =>
    column.map((day, dow) =>
      day ? `<rect x="${week * step}" y="${dow * step}" width="${cell}" height="${cell}" rx="${Math.round(cell * 0.16)}" fill="${colors(day.family, day.level)}"/>` : '',
    ),
  );
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rects.join('')}</svg>`, width, height };
}

/** A gradient stop: colour (hex), opacity, offset (0-1). */
export type Stop = readonly [string, number, number];

export type BackdropLayer =
  | { kind: 'solid'; color: string }
  /** CSS angle convention: 0 points up, 90 right, 180 down. */
  | { kind: 'linear'; angle: number; stops: readonly Stop[] }
  /** An ellipse centred at (cx, cy) with radii (rx, ry), all as fractions of the width and height. */
  | { kind: 'radial'; cx: number; cy: number; rx: number; ry: number; stops: readonly Stop[] };

const stopTags = (stops: readonly Stop[]) =>
  stops.map(([color, opacity, offset]) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`).join('');

/**
 * Layered gradients as one flat SVG, bottom layer first, for a card's background. Satori turns a
 * CSS gradient background into an SVG <pattern>, which resvg rasterises slowly (most of a card's
 * render time); plain gradient fills on rects draw in a fraction of it.
 */
export function backdropSvg(width: number, height: number, layers: readonly BackdropLayer[]): string {
  const defs: string[] = [];
  const rects = layers.map((layer, index) => {
    if (layer.kind === 'solid') return `<rect width="${width}" height="${height}" fill="${layer.color}"/>`;
    const id = `b${index}`;
    if (layer.kind === 'linear') {
      const radians = (layer.angle * Math.PI) / 180;
      const dx = Math.sin(radians) / 2;
      const dy = -Math.cos(radians) / 2;
      const r = (value: number) => Math.round(value * 1e4) / 1e4;
      defs.push(`<linearGradient id="${id}" x1="${r(0.5 - dx)}" y1="${r(0.5 - dy)}" x2="${r(0.5 + dx)}" y2="${r(0.5 + dy)}">${stopTags(layer.stops)}</linearGradient>`);
    } else {
      const transform = `translate(${layer.cx * width} ${layer.cy * height}) scale(${layer.rx * width} ${layer.ry * height})`;
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="${transform}">${stopTags(layer.stops)}</radialGradient>`);
    }
    return `<rect width="${width}" height="${height}" fill="url(#${id})"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs.join('')}</defs>${rects.join('')}</svg>`;
}
