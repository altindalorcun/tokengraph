import { CLAUDE_CODE_SOURCE } from '@tokengraph/core';
import { envPath, kindedRoot, parseKindedRoot, pathFor, type RootContext, type RootSpec, type RootTarget } from '../../agent-roots.js';

/** The folders of Claude Desktop's app data that hold Claude Code and Cowork session folders (and nothing else is walked). */
export const CLAUDE_DESKTOP_SESSION_DIRS = ['local-agent-mode-sessions', 'claude-code-sessions'] as const;

const DESKTOP = 'desktop';

/** Claude Desktop's app data folder where no environment variable moves it: `~/Library/Application Support/Claude`, `<home>\AppData\Roaming\Claude`, `~/.config/Claude`. */
function desktopDefault(ctx: RootContext): string {
  const path = pathFor(ctx.platform);
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  if (ctx.platform === 'win32') return path.join(ctx.home, 'AppData', 'Roaming', 'Claude');
  return path.join(ctx.home, '.config', 'Claude');
}

/** `%APPDATA%\Claude` on Windows and `$XDG_CONFIG_HOME/Claude` on Linux, when the variable is set. */
function desktopFromEnv(ctx: RootContext): string | undefined {
  const path = pathFor(ctx.platform);
  if (ctx.platform === 'win32') {
    const appData = envPath(ctx, 'APPDATA');
    return appData ? path.join(appData, 'Claude') : undefined;
  }
  if (ctx.platform === 'darwin') return undefined;
  const config = envPath(ctx, 'XDG_CONFIG_HOME');
  return config ? path.join(config, 'Claude') : undefined;
}

/**
 * Claude Code's config folders and Claude Desktop's app data. A plain root is a config folder
 * (`~/.claude`, or `$CLAUDE_CONFIG_DIR`, absolute only: a relative value means a different folder to
 * every process, and VS Code itself applies the setting only when absolute); read through its
 * `projects/` and `transcripts/`. A `desktop:` root is Claude Desktop's app data; only its two
 * session folders are walked (see `desktop.ts`).
 */
export const CLAUDE_CODE_ROOTS: RootSpec = {
  source: CLAUDE_CODE_SOURCE,

  defaults(ctx) {
    return [pathFor(ctx.platform).join(ctx.home, '.claude'), kindedRoot(DESKTOP, desktopDefault(ctx))];
  },

  fromEnv(ctx) {
    const roots: string[] = [];
    const config = envPath(ctx, 'CLAUDE_CONFIG_DIR');
    if (config) roots.push(config);
    const desktop = desktopFromEnv(ctx);
    if (desktop) roots.push(kindedRoot(DESKTOP, desktop));
    return roots;
  },

  targets(root, ctx): RootTarget[] {
    const path = pathFor(ctx.platform);
    const parsed = parseKindedRoot(root);
    if (parsed.kind === DESKTOP) return CLAUDE_DESKTOP_SESSION_DIRS.map((name) => ({ path: path.join(parsed.path, name), kind: 'desktop' }));
    // Claude Code's `transcripts/` (flat session files) sits next to `projects/` in the config folder.
    return [
      { path: path.join(root, 'projects'), kind: 'projects' },
      { path: path.join(root, 'transcripts'), kind: 'transcripts' },
    ];
  },
};
