import type { Adapter } from '@tokengraph/core';
import { createOpenCodeFamilyAdapter, familyDataDir, type OpenCodeFamilyOptions } from './family.js';
import { OPENCODE_FLAVOUR } from './flavour.js';

/** `${XDG_DATA_HOME || ~/.local/share}/opencode` — the same rule OpenCode itself uses (never `~/Library/...` on macOS). */
export function openCodeDataDir(): string {
  return familyDataDir(OPENCODE_FLAVOUR);
}

export type OpenCodeAdapterOptions = OpenCodeFamilyOptions;

/**
 * Reads OpenCode's own local, per-request usage: the pre-1.2 JSON store and every
 * `opencode*.db` in the data directory (see `createOpenCodeFamilyAdapter` and `OpenCodeAggregator`).
 */
export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): Adapter {
  return createOpenCodeFamilyAdapter(OPENCODE_FLAVOUR, options);
}
