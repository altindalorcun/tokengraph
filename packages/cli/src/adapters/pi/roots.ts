import { PI_SOURCE } from '@tokengraph/core';
import { envPath, kindedRoot, parseKindedRoot, pathFor, type RootSpec } from '../../agent-roots.js';

const SESSIONS = 'sessions';

/**
 * A plain root is a pi agent folder (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`), read through its
 * `sessions/`. A `sessions:` root is a session folder named directly by `$PI_CODING_AGENT_SESSION_DIR`
 * (sessions saved before it was set stay in the agent folder, so both are read). Environment values
 * are read the way pi's `normalizePath` does: `~` (and `~\` on Windows), `file://` URLs and, on
 * Windows, Git Bash drive paths; a relative value is ignored. The `sessionDir` setting and the
 * `--session-dir` flag cannot be seen from a later run.
 */
export const PI_ROOTS: RootSpec = {
  source: PI_SOURCE,

  defaults: (ctx) => [pathFor(ctx.platform).join(ctx.home, '.pi', 'agent')],

  fromEnv(ctx) {
    const roots: string[] = [];
    const agent = envPath(ctx, 'PI_CODING_AGENT_DIR', { fileUrl: true, shellPaths: true });
    if (agent) roots.push(agent);
    const sessions = envPath(ctx, 'PI_CODING_AGENT_SESSION_DIR', { fileUrl: true, shellPaths: true });
    if (sessions) roots.push(kindedRoot(SESSIONS, sessions));
    return roots;
  },

  targets(root, ctx) {
    const parsed = parseKindedRoot(root);
    if (parsed.kind === SESSIONS) return [{ path: parsed.path, kind: 'sessions' }];
    return [{ path: pathFor(ctx.platform).join(root, 'sessions'), kind: 'sessions' }];
  },
};
