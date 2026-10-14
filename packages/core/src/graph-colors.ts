import type { Level } from './levels.js';
import type { ModelFamily } from './model-makers.js';

/**
 * Every colour the graph can paint, in one module. The React grid and the SVG endpoint both read
 * from here: two implementations of the same ramp drift within a week, and the endpoint renders
 * outside the browser where the stylesheet's tokens do not exist.
 */

export type ColorMode = 'single' | 'per-model';
export type Theme = 'light' | 'dark';

export type Ramp = readonly [string, string, string, string, string, string];

/** The single-colour ramp, in the brand red. Level 0 is "no activity"; 1-5 climb with volume. */
export const GRAPH_RAMP_DARK: Ramp = ['#292524', '#450a0a', '#991b1b', '#b91c1c', '#dc2626', '#f87171'];

/** Inverted for a light surface: pale means little, dark means a lot. */
export const GRAPH_RAMP_LIGHT: Ramp = ['#ebe9e6', '#fecaca', '#fca5a5', '#ef4444', '#dc2626', '#991b1b'];

/** The Less -> More scale in by-model mode: no hue, because there each day takes its family's. Level 0 is overridden by the surface. */
export const NEUTRAL_RAMP_DARK: Ramp = ['#292524', '#3b4047', '#575d65', '#767d87', '#9ba2ab', '#c9ced4'];
export const NEUTRAL_RAMP_LIGHT: Ramp = ['#ebe9e6', '#d3d8dd', '#b3b9c1', '#8f969f', '#6b727b', '#3d434b'];

/** Claude's own orange: the Claude family keeps it so a red day never reads as Claude. */
export const CLAUDE_RAMP_DARK: Ramp = ['#292524', '#431407', '#9a3412', '#c2410c', '#ea580c', '#fb923c'];
export const CLAUDE_RAMP_LIGHT: Ramp = ['#ebe9e6', '#fed7aa', '#fdba74', '#f97316', '#ea580c', '#9a3412'];

/**
 * One hue per model family. Eight hues are not all distinguishable under colour-vision
 * deficiency; hue is never the only channel (the legend carries logos and names, each cell's
 * `data-tip` text names its family).
 */
export const FAMILY_RAMPS: Record<ModelFamily, Ramp> = {
  claude: CLAUDE_RAMP_DARK,
  gpt: ['#292524', '#172554', '#1e40af', '#1d4ed8', '#2563eb', '#60a5fa'],
  gemini: ['#292524', '#2e1065', '#5b21b6', '#6d28d9', '#7c3aed', '#a78bfa'],
  deepseek: ['#292524', '#042f2e', '#115e59', '#0f766e', '#0d9488', '#2dd4bf'],
  qwen: ['#292524', '#500724', '#9d174d', '#be185d', '#db2777', '#f472b6'],
  glm: ['#292524', '#052e16', '#166534', '#15803d', '#16a34a', '#4ade80'],
  kimi: ['#292524', '#422006', '#854d0e', '#a16207', '#ca8a04', '#facc15'],
  other: ['#292524', '#1e293b', '#334155', '#475569', '#64748b', '#cbd5e1'],
};

/** The same hues inverted for a light surface (pale means little). The README graph and the terminal view both read these. */
export const FAMILY_RAMPS_LIGHT: Record<ModelFamily, Ramp> = {
  claude: CLAUDE_RAMP_LIGHT,
  gpt: ['#e7e5e4', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'],
  gemini: ['#e7e5e4', '#ede9fe', '#c4b5fd', '#8b5cf6', '#6d28d9', '#4c1d95'],
  deepseek: ['#e7e5e4', '#ccfbf1', '#5eead4', '#14b8a6', '#0f766e', '#134e4a'],
  qwen: ['#e7e5e4', '#fce7f3', '#f9a8d4', '#ec4899', '#be185d', '#831843'],
  glm: ['#e7e5e4', '#dcfce7', '#86efac', '#22c55e', '#15803d', '#14532d'],
  kimi: ['#e7e5e4', '#fef9c3', '#fde047', '#eab308', '#a16207', '#713f12'],
  other: ['#e7e5e4', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#334155'],
};

/** Each family's brightest dark-ramp colour, for callers that need one representative colour. */
export const FAMILY_HUES: Record<ModelFamily, string> = {
  claude: FAMILY_RAMPS.claude[5],
  gpt: FAMILY_RAMPS.gpt[5],
  gemini: FAMILY_RAMPS.gemini[5],
  deepseek: FAMILY_RAMPS.deepseek[5],
  qwen: FAMILY_RAMPS.qwen[5],
  glm: FAMILY_RAMPS.glm[5],
  kimi: FAMILY_RAMPS.kimi[5],
  other: FAMILY_RAMPS.other[5],
};

/**
 * The graph screen per theme: surface, inks and the empty-cell colour. `renderGraphSvg` and the
 * terminal view read these values, so they stay one design. `ring` and `shade` are the screen's
 * hairline and inset top shadow.
 */
export interface DisplaySurface {
  background: string;
  ink: string;
  muted: string;
  /** Level 0, an idle day. */
  empty: string;
  /** The 1px inset hairline. */
  ring: string;
  /** The inset shadow along the top edge. */
  shade: string;
}

export const DISPLAY_SURFACES: Record<Theme, DisplaySurface> = {
  light: {
    background: '#ffffff',
    ink: '#1b1f24',
    muted: '#59606a',
    empty: '#e3e6ea',
    ring: 'rgb(0 0 0 / 0.06)',
    shade: 'rgb(0 0 0 / 0.08)',
  },
  dark: {
    background: '#0b0c0e',
    ink: '#eef0f2',
    muted: '#a3aab3',
    empty: '#22282a',
    ring: 'rgb(255 255 255 / 0.04)',
    shade: 'rgb(0 0 0 / 0.5)',
  },
};

export const COLOR_MODES: readonly ColorMode[] = ['single', 'per-model'];

/** Anything unrecognised falls back to single hue, which is the default and always readable. */
export function parseColorMode(value: unknown): ColorMode {
  return value === 'per-model' ? 'per-model' : 'single';
}

export interface CellColorOptions {
  colorMode?: ColorMode;
  theme?: Theme;
  /** The model family that burned the most tokens that day; ignored in single-hue mode. */
  family?: ModelFamily | null;
  /** Overrides level 0, for a surface whose idle colour is not the ramp's own (see DISPLAY_SURFACES). */
  empty?: string;
}

export function cellColor(level: Level, options: CellColorOptions = {}): string {
  const { colorMode = 'single', theme = 'dark', family = null, empty } = options;
  const ramp = theme === 'light' ? GRAPH_RAMP_LIGHT : GRAPH_RAMP_DARK;
  if (level === 0) return empty ?? ramp[0];
  if (colorMode === 'per-model' && family) return (theme === 'light' ? FAMILY_RAMPS_LIGHT : FAMILY_RAMPS)[family][level];
  return ramp[level];
}

/** The intensity legend, Less to More, minus the empty step the design leaves out of the swatches. */
export function legendRamp(theme: Theme = 'dark', colorMode: ColorMode = 'single'): readonly string[] {
  if (colorMode === 'per-model') return theme === 'light' ? NEUTRAL_RAMP_LIGHT : NEUTRAL_RAMP_DARK;
  return theme === 'light' ? GRAPH_RAMP_LIGHT : GRAPH_RAMP_DARK;
}
