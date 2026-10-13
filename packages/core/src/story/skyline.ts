import { FAMILY_RAMPS } from '../graph-colors.js';
import type { ModelFamily } from '../model-makers.js';
import { alpha, darken, lighten } from './color.js';
import type { StoryDay } from './data.js';

/**
 * The contribution graph stood up in 3D: every day a tower on a floor seen from above and to the
 * front, weeks running left to right, weekdays running toward the viewer, height by weighted
 * tokens. Days in the shared period are lit in their family's hue; the weeks around them stand
 * dark, for context. Returned as an SVG string: the PNG renderer draws nested SVG through resvg,
 * which has no fonts, so this holds shapes only, and the card lays text over it at the
 * coordinates returned here. Pure, so it is tested without a renderer.
 */

export interface SkylineOptions {
  /** Width of the drawing in px; the cell size follows from it and the number of weeks. */
  width: number;
  /** Tallest tower in px. */
  maxHeight: number;
  /** The day that gets the light beam, or null for none. */
  beaconDate: string | null;
  /** The accent for the beam and the floor glow. */
  family: ModelFamily;
  /** 'dark' for a dark card; 'clear' for a transparent sticker, where the dark city turns to frosted glass. */
  surface: 'dark' | 'clear';
  /** Room above the tallest tower for the beam to fade out in. */
  headroom?: number;
}

export interface Skyline {
  svg: string;
  width: number;
  height: number;
  /** Top centre of the beacon tower, in the drawing's px, for a label to point at. */
  beacon: { x: number; y: number } | null;
  /** Where the floor's front edge sits, so a card can lay text under it. */
  floorBottom: number;
}

const DEG = Math.PI / 180;
/** Weeks run nearly flat to the right; weekdays run steeply toward the viewer. */
const WEEK_ANGLE = 9 * DEG;
const DAY_ANGLE = 34 * DEG;
/** Fraction of a cell left empty on every side of a tower's footprint. */
const GAP = 0.13;
const MIN_TOWER = 5;
/** Below 1, so one enormous day does not flatten every other tower to a sliver. */
const HEIGHT_EXPONENT = 0.62;

function r(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function points(list: readonly (readonly [number, number])[]): string {
  return list.map(([x, y]) => `${r(x)},${r(y)}`).join(' ');
}

/** Towers rise with the day's share of the heaviest day shown, never below a visible stub. */
export function towerHeight(weighted: number, max: number, maxHeight: number): number {
  if (weighted <= 0 || max <= 0) return 0;
  return MIN_TOWER + (maxHeight - MIN_TOWER) * Math.min(1, weighted / max) ** HEIGHT_EXPONENT;
}

/** The unlit city: dark stone on a dark card, frosted glass on a transparent sticker. */
const DARK_CITY = { top: '#262c33', front: '#181c21', side: '#111418', rim: '#3b444e' };

export function renderSkyline(weeks: readonly (readonly (StoryDay | null)[])[], options: SkylineOptions): Skyline {
  const columns = weeks.length;
  const headroom = options.headroom ?? Math.round(options.maxHeight * 0.4);
  // Air on every side, so the beam's flare over an edge tower is not cut off.
  const pad = 26;
  const s = (options.width - pad * 2) / (columns * Math.cos(WEEK_ANGLE) + 7 * Math.cos(DAY_ANGLE));
  const ux = s * Math.cos(WEEK_ANGLE);
  const uy = s * Math.sin(WEEK_ANGLE);
  const vx = s * Math.cos(DAY_ANGLE);
  const vy = s * Math.sin(DAY_ANGLE);
  const ox = pad + 7 * vx;
  const oy = headroom + options.maxHeight + pad;
  const project = (u: number, v: number, z = 0): [number, number] => [ox + u * ux - v * vx, oy + u * uy + v * vy - z];
  const floorBottom = oy + columns * uy + 7 * vy;
  const height = Math.ceil(floorBottom + pad);

  const max = Math.max(0, ...weeks.flat().map((day) => day?.weighted ?? 0));
  const accent = FAMILY_RAMPS[options.family][5];
  const clear = options.surface === 'clear';

  const defs = [
    `<linearGradient id="beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${accent}" stop-opacity="0.7"/><stop offset="0.5" stop-color="${accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>`,
    `<radialGradient id="pool" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${accent}" stop-opacity="${clear ? 0.35 : 0.3}"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.42"/></linearGradient>`,
    `<filter id="glow" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="${r(s * 0.5)}"/></filter>`,
  ];

  const parts: string[] = [];
  const floor = [project(0, 0), project(columns, 0), project(columns, 7), project(0, 7)] as const;
  parts.push(
    `<polygon points="${points(floor)}" fill="${clear ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.018)'}" stroke="${clear ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.06)'}" stroke-width="1.5"/>`,
  );

  // Painter's order: towers further back (smaller week + weekday) first, nearer ones over them.
  const cells: { week: number; dow: number; day: StoryDay }[] = [];
  weeks.forEach((column, week) =>
    column.forEach((day, dow) => {
      if (day) cells.push({ week, dow, day });
    }),
  );
  cells.sort((p, q) => p.week + p.dow - (q.week + q.dow) || p.week - q.week);

  // Light pools on the floor under every lit tower, drawn before any tower so towers stand in them.
  for (const { week, dow, day } of cells) {
    if (!day.inPeriod || day.weighted <= 0) continue;
    const [px, py] = project(week + 0.5, dow + 0.5);
    const glow = day.date === options.beaconDate ? 2.4 : 1.1;
    parts.push(`<ellipse cx="${r(px)}" cy="${r(py)}" rx="${r(s * glow * 1.3)}" ry="${r(s * glow * 0.75)}" fill="url(#pool)"/>`);
  }

  let beacon: Skyline['beacon'] = null;
  let beam = '';

  for (const { week, dow, day } of cells) {
    const u0 = week + GAP;
    const u1 = week + 1 - GAP;
    const v0 = dow + GAP;
    const v1 = dow + 1 - GAP;
    const h = towerHeight(day.weighted, max, options.maxHeight);
    // Atmospheric depth: older weeks sit further into the haze.
    const depth = 0.5 + 0.5 * ((week + 1) / columns);

    if (h === 0) {
      const tile = [project(u0, v0), project(u1, v0), project(u1, v1), project(u0, v1)];
      const fill = clear ? `fill="#ffffff" fill-opacity="0.22" stroke="#000" stroke-opacity="0.1" stroke-width="1"` : `fill="#1d2227"`;
      parts.push(`<polygon points="${points(tile)}" ${fill} opacity="${r(depth)}"/>`);
      continue;
    }

    const lit = day.inPeriod;
    const isBeacon = day.date === options.beaconDate;
    const ramp = FAMILY_RAMPS[day.family ?? 'other'];
    let top: string;
    let front: string;
    let side: string;
    let rim: string;
    if (lit) {
      top = isBeacon ? lighten(ramp[5], 0.2) : ramp[Math.max(3, day.level)]!;
      // On a photo the sticker's lit towers keep lighter sides, or they read as dark slabs.
      front = darken(top, clear ? 0.18 : 0.38);
      side = darken(top, clear ? 0.34 : 0.6);
      rim = lighten(top, 0.4);
    } else if (clear) {
      top = '#ffffff';
      front = '#ffffff';
      side = '#ffffff';
      rim = '#ffffff';
    } else {
      ({ top, front, side, rim } = DARK_CITY);
    }

    const t = (u: number, v: number) => project(u, v, h);
    const topFace = [t(u0, v0), t(u1, v0), t(u1, v1), t(u0, v1)];
    const sideFace = [t(u1, v0), t(u1, v1), project(u1, v1), project(u1, v0)];
    const frontFace = [t(u0, v1), t(u1, v1), project(u1, v1), project(u0, v1)];

    if (!lit && clear) {
      // Frosted glass: light faces with a bright rim and a faint dark edge, so it reads on a dark
      // photo and a bright one alike, and the photo still shows through.
      parts.push(
        `<g opacity="${r(depth)}">` +
          `<polygon points="${points(frontFace)}" fill="#fff" fill-opacity="0.2" stroke="#000" stroke-opacity="0.14" stroke-width="1"/>` +
          `<polygon points="${points(sideFace)}" fill="#000" fill-opacity="0.12" stroke="#000" stroke-opacity="0.14" stroke-width="1"/>` +
          `<polygon points="${points(topFace)}" fill="#fff" fill-opacity="0.45" stroke="#fff" stroke-opacity="0.8" stroke-width="1"/>` +
          `</g>`,
      );
      continue;
    }

    parts.push(
      `<g opacity="${r(lit ? Math.max(depth, 0.85) : depth)}">` +
        `<polygon points="${points(frontFace)}" fill="${front}"/>` +
        `<polygon points="${points(frontFace)}" fill="url(#shade)"/>` +
        `<polygon points="${points(sideFace)}" fill="${side}"/>` +
        `<polygon points="${points(sideFace)}" fill="url(#shade)"/>` +
        `<polygon points="${points(topFace)}" fill="${top}" stroke="${rim}" stroke-width="1" stroke-opacity="${lit ? 0.6 : 0.5}"/>` +
        `</g>`,
    );

    if (isBeacon && lit) {
      const [tx, ty] = t((u0 + u1) / 2, (v0 + v1) / 2);
      beacon = { x: tx, y: ty };
      const lx = t(u0, v1)[0];
      const rx = t(u1, v0)[0];
      const w = rx - lx;
      const beamShape = [
        [lx + w * 0.08, ty],
        [rx - w * 0.08, ty],
        [rx + w * 0.5, 0],
        [lx - w * 0.5, 0],
      ] as const;
      beam =
        `<polygon points="${points(beamShape)}" fill="url(#beam)"/>` +
        `<ellipse cx="${r(tx)}" cy="${r(ty)}" rx="${r(w * 0.9)}" ry="${r(w * 0.45)}" fill="${accent}" opacity="0.75" filter="url(#glow)"/>` +
        `<polygon points="${points(topFace)}" fill="${lighten(top, 0.35)}"/>` +
        `<ellipse cx="${r(tx)}" cy="${r(ty)}" rx="${r(w * 0.3)}" ry="${r(w * 0.14)}" fill="#ffffff" opacity="0.85" filter="url(#glow)"/>` +
        `<rect x="${r(tx - 0.75)}" y="${r(ty * 0.35)}" width="1.5" height="${r(ty * 0.65)}" fill="${alpha(lighten(accent, 0.6), 0.35)}"/>`;
    }
  }

  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${height}" viewBox="0 0 ${options.width} ${height}">` +
      `<defs>${defs.join('')}</defs>${parts.join('')}${beam}</svg>`,
    width: options.width,
    height,
    beacon,
    floorBottom,
  };
}
