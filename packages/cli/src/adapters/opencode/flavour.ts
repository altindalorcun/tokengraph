import { OPENCODE_SOURCE, type KnownSource } from '@tokengraph/core';
import { OPENCODE_RULES, type SemanticsRules } from './semantics.js';

/**
 * Everything that differs between OpenCode and a fork that writes the same database (Kilo CLI):
 * where the files live, how the product is named in notes, and which release numbers its
 * `getUsage()` history is keyed to. The reading and aggregation code is shared.
 */
export interface OpenCodeFlavour {
  source: KnownSource;
  /** The product name used in notes. */
  displayName: string;
  /** The folder under `${XDG_DATA_HOME || ~/.local/share}`. */
  dataDirName: string;
  /** The database file name used in notes. */
  dbFileName: string;
  /** Matches every database file in the data dir to read. */
  dbPattern: RegExp;
  /** The environment variable that points at one database (absolute, or relative to the data dir). */
  dbEnvVar: string;
  rules: SemanticsRules;
  /** Whether the pre-SQLite `storage/` JSON store is read. */
  readsJsonStorage: boolean;
  /** Whether a step-finish part's own `model` (the real model behind a routed id) replaces the message's. */
  readsStepModels: boolean;
  /** Providers whose records are not usage and are dropped without a note (lower case). */
  ignoredProviders: readonly string[];
}

export const OPENCODE_FLAVOUR: OpenCodeFlavour = {
  source: OPENCODE_SOURCE,
  displayName: 'OpenCode',
  dataDirName: 'opencode',
  dbFileName: 'opencode.db',
  // `opencode.db`, or a channel-suffixed sibling such as `opencode-dev.db` / `opencode-beta.db`.
  dbPattern: /^opencode(-[^.]+)?\.db$/,
  dbEnvVar: 'OPENCODE_DB',
  rules: OPENCODE_RULES,
  readsJsonStorage: true,
  readsStepModels: false,
  ignoredProviders: [],
};
