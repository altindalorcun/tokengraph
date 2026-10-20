import { CODEX_CLI_SOURCE } from '@tokengraph/core';
import { envPath, pathFor, type RootSpec } from '../../agent-roots.js';

/**
 * `$CODEX_HOME` when it is set to something (an empty value counts as unset, as in Codex), else
 * `~/.codex`; the same on every OS. Read through `sessions/` and `archived_sessions/` only: the
 * prompt history and auth files next to them are not usage. A relative `CODEX_HOME` is ignored:
 * Codex resolves it against its own working directory, which a later run cannot know.
 */
export const CODEX_ROOTS: RootSpec = {
  source: CODEX_CLI_SOURCE,
  defaults: (ctx) => [pathFor(ctx.platform).join(ctx.home, '.codex')],
  fromEnv(ctx) {
    const home = envPath(ctx, 'CODEX_HOME');
    return home ? [home] : [];
  },
  targets(root, ctx) {
    const path = pathFor(ctx.platform);
    return [
      { path: path.join(root, 'sessions'), kind: 'sessions' },
      { path: path.join(root, 'archived_sessions'), kind: 'sessions' },
    ];
  },
};
