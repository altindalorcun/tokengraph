import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Both resolve from this module's own location, which works for the tsc output (dist/bin-path.js sits next to
// dist/bin.js) and for the published bundle (everything is inlined into bundle/bin.js). Each output directory is
// one level below the package root, so `../package.json` is the package's own manifest in both.

/** Absolute path of the CLI entry script, as hooks and the scheduler must run it. */
export function binPath(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url));
}

/** The installed package's version, from its package.json. */
export function cliVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// npm exec / npx (`~/.npm/_npx/<hash>/…`), pnpm dlx (`…/pnpm/dlx/…`), yarn dlx (`…/dlx-<n>/…`) and bunx (`…/bunx-…`).
const EPHEMERAL_INSTALL = /[\\/](?:_npx|dlx(?:-[^\\/]*)?|bunx-[^\\/]*)[\\/]/;

/** True when the CLI runs from a package runner's cache, which can be cleared at any time. */
export function isEphemeralInstall(path: string): boolean {
  return EPHEMERAL_INSTALL.test(path);
}

/**
 * Hooks and the scheduler store the absolute path of this script, so installing them from an npx cache would
 * leave them pointing at a file npm may delete later, and they would silently stop syncing. Returns the message
 * to print instead of installing, or null when this copy is a lasting install.
 */
export function ephemeralInstallError(retry: string, path: string = binPath()): string | null {
  if (!isEphemeralInstall(path)) return null;
  return (
    `This tokengraph runs from a temporary package cache:\n  ${path}\n` +
    'A hook or schedule pointing there would stop working once the cache is cleared. Install it first, then retry:\n' +
    `  npm install -g tokengraph\n  ${retry}`
  );
}
