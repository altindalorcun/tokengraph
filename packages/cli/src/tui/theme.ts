import { DISPLAY_SURFACES, FAMILY_RAMPS, FAMILY_RAMPS_LIGHT, type ModelFamily, type Theme } from '@tokengraph/core';

export interface TuiTheme {
  name: Theme;
  bg: string;
  panel: string;
  border: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  good: string;
  bad: string;
  live: string;
  empty: string;
}

const DARK: TuiTheme = {
  name: 'dark',
  bg: DISPLAY_SURFACES.dark.background,
  panel: '#111317',
  border: '#2a2f36',
  ink: DISPLAY_SURFACES.dark.ink,
  muted: DISPLAY_SURFACES.dark.muted,
  faint: '#5b636d',
  accent: '#f87171',
  good: '#4ade80',
  bad: '#f87171',
  live: '#22c55e',
  empty: DISPLAY_SURFACES.dark.empty,
};

const LIGHT: TuiTheme = {
  name: 'light',
  bg: DISPLAY_SURFACES.light.background,
  panel: '#f6f7f9',
  border: '#d5dae0',
  ink: DISPLAY_SURFACES.light.ink,
  muted: DISPLAY_SURFACES.light.muted,
  faint: '#9aa1ab',
  accent: '#dc2626',
  good: '#16a34a',
  bad: '#dc2626',
  live: '#16a34a',
  empty: DISPLAY_SURFACES.light.empty,
};

export function tuiTheme(name: Theme): TuiTheme {
  return name === 'light' ? LIGHT : DARK;
}

/** One representative colour per family for bars and swatches. */
export function familyColor(family: ModelFamily | null, theme: TuiTheme): string {
  if (family === null) return theme.muted;
  return theme.name === 'light' ? FAMILY_RAMPS_LIGHT[family][4] : FAMILY_RAMPS[family][5];
}

/** The flame's palette, hottest first. */
export const FLAME_PALETTE: readonly string[] = ['#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d'];
