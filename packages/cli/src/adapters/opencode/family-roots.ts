import { absolutePath, envPath, pathFor, type RootContext, type RootSpec } from '../../agent-roots.js';
import type { OpenCodeFlavour } from './flavour.js';

/** A root that names one database file instead of a data folder. */
export function isDatabaseRoot(root: string): boolean {
  return /\.db$/i.test(root);
}

function dataHome(ctx: RootContext): string {
  return envPath(ctx, 'XDG_DATA_HOME') ?? pathFor(ctx.platform).join(ctx.home, '.local', 'share');
}

/**
 * OpenCode and Kilo keep `${XDG_DATA_HOME || ~/.local/share}/<product>` on every OS, macOS and
 * Windows included (never `~/Library` or `%APPDATA%`). A root is that data folder (every database
 * matching the flavour's pattern in it, plus OpenCode's pre-1.2 `storage/` tree), or, when the
 * product's `..._DB` variable names a database, that one file (an absolute path as is, a relative
 * one against the data folder, as the products resolve it; `:memory:` is nothing to read).
 */
export function familyRootSpec(flavour: OpenCodeFlavour): RootSpec {
  return {
    source: flavour.source,

    defaults: (ctx) => [pathFor(ctx.platform).join(ctx.home, '.local', 'share', flavour.dataDirName)],

    fromEnv(ctx) {
      const path = pathFor(ctx.platform);
      const roots: string[] = [];
      const xdg = envPath(ctx, 'XDG_DATA_HOME');
      if (xdg) roots.push(path.join(xdg, flavour.dataDirName));
      const override = ctx.env[flavour.dbEnvVar]?.trim();
      if (override && override !== ':memory:') {
        const file = absolutePath(ctx, override) ?? path.join(dataHome(ctx), flavour.dataDirName, override);
        roots.push(path.normalize(file));
      }
      return roots;
    },

    targets: (root) => [{ path: root, kind: isDatabaseRoot(root) ? 'db' : 'dir' }],
  };
}
