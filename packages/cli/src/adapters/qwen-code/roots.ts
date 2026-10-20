import { QWEN_CODE_SOURCE } from '@tokengraph/core';
import { envPath, pathFor, type RootSpec } from '../../agent-roots.js';

/**
 * A root is a Qwen runtime folder: `$QWEN_RUNTIME_DIR`, `$QWEN_HOME` (the `.qwen` folder itself) or
 * `~/.qwen`. Each is read through `projects/` (chats, subagents) and `usage/` (Qwen's own ledger):
 * sessions recorded before a variable was set stay in the home. Qwen expands `~` and resolves a
 * relative value against its working directory or project; a later run cannot know that folder, so a
 * relative value is ignored here. A runtime dir set in settings.json is not followed.
 */
export const QWEN_ROOTS: RootSpec = {
  source: QWEN_CODE_SOURCE,
  defaults: (ctx) => [pathFor(ctx.platform).join(ctx.home, '.qwen')],
  fromEnv(ctx) {
    return [envPath(ctx, 'QWEN_RUNTIME_DIR'), envPath(ctx, 'QWEN_HOME')].filter((dir): dir is string => dir !== undefined);
  },
  targets(root, ctx) {
    const path = pathFor(ctx.platform);
    return [
      { path: path.join(root, 'projects'), kind: 'projects' },
      { path: path.join(root, 'usage'), kind: 'usage' },
    ];
  },
};
