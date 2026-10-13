import { existsSync } from 'node:fs';

// `<prefix>/Cellar/<formula>/<version>/bin/node` (Homebrew is POSIX-only, so only `/` is handled).
const CELLAR_NODE = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

/**
 * Homebrew's `process.execPath` is a versioned Cellar path that vanishes on `brew upgrade node`.
 * The unversioned `<prefix>/opt/<formula>/bin/node` symlink survives upgrades, so prefer it when it exists.
 * Other version managers (nvm, fnm, volta, asdf) are deliberately left unchanged: their paths are
 * per-version by design and have no stable equivalent we could pick for the user.
 */
export function stableNodePath(execPath: string, exists: (path: string) => boolean = existsSync): string {
  const match = CELLAR_NODE.exec(execPath);
  if (!match) return execPath;
  const stable = `${match[1]}/opt/${match[2]}/bin/node`;
  return exists(stable) ? stable : execPath;
}
