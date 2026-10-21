import { GEMINI_CLI_SOURCE } from '@tokengraph/core';
import { envPath, pathFor, type RootSpec } from '../../agent-roots.js';

/**
 * A root is the folder Gemini CLI treats as home: `$GEMINI_CLI_HOME` (any non-empty value) or the
 * user's home. Chats live in `<home>/.gemini/tmp`, and under the macOS seatbelt sandbox in
 * `<home>/.cache/.gemini/tmp`: Gemini computes that one from the same home, so it follows
 * `GEMINI_CLI_HOME` too. A relative value is ignored.
 */
export const GEMINI_ROOTS: RootSpec = {
  source: GEMINI_CLI_SOURCE,
  defaults: (ctx) => [ctx.home],
  fromEnv(ctx) {
    const home = envPath(ctx, 'GEMINI_CLI_HOME');
    return home ? [home] : [];
  },
  targets(root, ctx) {
    const path = pathFor(ctx.platform);
    return [
      { path: path.join(root, '.gemini', 'tmp'), kind: 'tmp' },
      { path: path.join(root, '.cache', '.gemini', 'tmp'), kind: 'tmp' },
    ];
  },
};
