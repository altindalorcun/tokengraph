import { COPILOT_CLI_SOURCE } from '@tokengraph/core';
import { envPath, pathFor, type RootSpec } from '../../agent-roots.js';

/**
 * `$COPILOT_HOME` (trimmed, `~` expanded, absolute only) or `~/.copilot`, the same on every OS; the
 * database is `session-store.db` in it. A `--config-dir` flag given to one run cannot be seen from
 * here. Copilot CLI is closed source, so whether it trims or expands `COPILOT_HOME` is unconfirmed.
 */
export const COPILOT_ROOTS: RootSpec = {
  source: COPILOT_CLI_SOURCE,
  defaults: (ctx) => [pathFor(ctx.platform).join(ctx.home, '.copilot')],
  fromEnv(ctx) {
    const home = envPath(ctx, 'COPILOT_HOME');
    return home ? [home] : [];
  },
  targets: (root, ctx) => [{ path: pathFor(ctx.platform).join(root, 'session-store.db'), kind: 'db' }],
};
