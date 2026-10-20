import { KILO_SOURCE } from '@tokengraph/core';
import type { OpenCodeFlavour } from '../opencode/flavour.js';
import type { SemanticsRules } from '../opencode/semantics.js';

/**
 * Kilo's `getUsage()` reached the disjoint-fields reading (period D) in 7.2.6; OpenCode's did in
 * 1.3.16, so OpenCode's threshold would add reasoning twice for 7.0.26-7.2.5 records. Kilo's AI SDK 6
 * upgrade and its double-count fix both shipped in 7.2.5, so the buggy window never existed there.
 * See `docs/agents/kilo-usage.md`.
 */
const KILO_RULES: SemanticsRules = {
  periodDFloor: '7.2.6',
  aisdk6WindowStartMs: null,
  aisdk6WindowClearedFrom: '7.2.5',
};

export const KILO_FLAVOUR: OpenCodeFlavour = {
  source: KILO_SOURCE,
  displayName: 'Kilo',
  dataDirName: 'kilo',
  dbFileName: 'kilo.db',
  // `kilo.db`, `kilo-<channel>.db`, or the `opencode-<channel>.db` Kilo falls back to when it already exists.
  // A plain `opencode.db` is not read: Kilo renamed it to `kilo.db` before its first SQLite release.
  dbPattern: /^(kilo(-[^.]+)?|opencode-[^.]+)\.db$/,
  dbEnvVar: 'KILO_DB',
  rules: KILO_RULES,
  // Kilo's releases before `kilo.db` kept JSON under `storage/`, a different, older format; not read.
  readsJsonStorage: false,
  readsStepModels: true,
  // Sessions migrated from the old VS Code extension: assistant rows with all-zero tokens.
  ignoredProviders: ['legacy'],
};
