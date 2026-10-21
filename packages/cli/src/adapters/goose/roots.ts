import { GOOSE_SOURCE } from '@tokengraph/core';
import { envPath, pathFor, type RootContext, type RootSpec } from '../../agent-roots.js';

/**
 * A root is a Goose data folder; the database is `<data>/sessions/sessions.db`. Goose's own rules
 * (crates/goose/src/config/paths.rs, etcetera 0.11): an absolute `$GOOSE_PATH_ROOT` is authoritative
 * (`<root>/data`; a relative one is ignored by Goose too); otherwise XDG on Linux and macOS
 * (`$XDG_DATA_HOME`, absolute only, else `~/.local/share`, plus `goose`) and `%APPDATA%\Block\goose\data`
 * on Windows. Older macOS and Linux builds left databases in three legacy folders; all of them are
 * read, each distinct database once (see the adapter for how copies of one database are told apart).
 */
export const GOOSE_ROOTS: RootSpec = {
  source: GOOSE_SOURCE,

  defaults(ctx: RootContext) {
    const path = pathFor(ctx.platform);
    if (ctx.platform === 'win32') return [path.join(ctx.home, 'AppData', 'Roaming', 'Block', 'goose', 'data')];
    const roots = [path.join(ctx.home, '.local', 'share', 'goose')];
    if (ctx.platform === 'darwin') {
      roots.push(path.join(ctx.home, 'Library', 'Application Support', 'goose'), path.join(ctx.home, 'Library', 'Application Support', 'Block', 'goose'));
    }
    roots.push(path.join(ctx.home, '.local', 'share', 'Block', 'goose'));
    return roots;
  },

  fromEnv(ctx) {
    const path = pathFor(ctx.platform);
    const roots: string[] = [];
    const explicit = envPath(ctx, 'GOOSE_PATH_ROOT');
    if (explicit) roots.push(path.join(explicit, 'data'));
    if (ctx.platform === 'win32') {
      const appData = envPath(ctx, 'APPDATA');
      if (appData) roots.push(path.join(appData, 'Block', 'goose', 'data'));
    } else {
      const xdg = envPath(ctx, 'XDG_DATA_HOME');
      if (xdg) roots.push(path.join(xdg, 'goose'));
    }
    return roots;
  },

  targets: (root, ctx) => [{ path: pathFor(ctx.platform).join(root, 'sessions', 'sessions.db'), kind: 'db' }],
};
