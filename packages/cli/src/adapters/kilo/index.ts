import type { Adapter } from '@tokengraph/core';
import { createOpenCodeFamilyAdapter, familyDataDir, type OpenCodeFamilyOptions } from '../opencode/family.js';
import { KILO_FLAVOUR } from './flavour.js';

/** `${XDG_DATA_HOME || ~/.local/share}/kilo` on every OS, as Kilo itself resolves it. */
export function kiloDataDir(): string {
  return familyDataDir(KILO_FLAVOUR);
}

/**
 * Reads Kilo CLI's local usage from `kilo.db`, which Kilo Code 7.x in VS Code and Kilo's Agent
 * Manager write too. It is OpenCode's database and writer, read by the same code with Kilo's own
 * version thresholds.
 */
export function createKiloAdapter(options: OpenCodeFamilyOptions = {}): Adapter {
  return createOpenCodeFamilyAdapter(KILO_FLAVOUR, options);
}
