import { CLINE_SOURCE } from '@tokengraph/core';
import { absolutePath, envPath, envText, kindedRoot, parseKindedRoot, pathFor, type RootContext, type RootSpec } from '../../agent-roots.js';

export const CLINE_EXTENSION_ID = 'saoudrizwan.claude-dev';

/**
 * Product folder names of the VS Code-family editors Cline's extension runs in (the `User/globalStorage`
 * parent). The first five were always read; the rest are the editors and builds named in the audit.
 * The extension id is the same on Open VSX, so any of them can hold Cline tasks, but only the VS Code,
 * Cursor, VSCodium and Windsurf folder names are confirmed from those products' source; Windsurf Next,
 * Trae, Kiro, Antigravity and Positron follow the same data-folder convention and cost nothing when absent.
 */
export const CLINE_EDITOR_HOSTS = [
  'Code',
  'Code - Insiders',
  'Code - OSS',
  'Cursor',
  'VSCodium',
  'VSCodium - Insiders',
  'Windsurf',
  'Windsurf - Next',
  'Positron',
  'Trae',
  'Kiro',
  'Antigravity',
] as const;

/** Folders a remote-server install of an editor keeps its user data under: `~/<name>/data/User/globalStorage/...`. */
export const CLINE_REMOTE_SERVERS = ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server', '.vscodium-server'] as const;

const SESSIONS = 'sessions';
const EDITORS = 'editors';
const SERVER = 'server';

/**
 * Cline's SDK resolves its home as `$HOME`, else `$USERPROFILE`, else `$HOMEDRIVE$HOMEPATH` (all trimmed,
 * `HOME` first even on Windows, where Git Bash exports it), so `~/.cline` can differ from `os.homedir()`.
 */
export function clineSdkHome(ctx: RootContext): string | undefined {
  const home = envText(ctx, 'HOME');
  const fromHome = home && home !== '~' ? home : undefined;
  const drive = envText(ctx, 'HOMEDRIVE');
  const homePath = envText(ctx, 'HOMEPATH');
  return absolutePath(ctx, fromHome ?? envText(ctx, 'USERPROFILE') ?? (drive && homePath ? `${drive}${homePath}` : undefined), { shellPaths: true });
}

/** Where an editor keeps its user data: `~/Library/Application Support`, `%APPDATA%`, `$XDG_CONFIG_HOME` or `~/.config`. */
function editorBase(ctx: RootContext): { fallback: string; fromEnv: string | undefined } {
  const path = pathFor(ctx.platform);
  if (ctx.platform === 'darwin') return { fallback: path.join(ctx.home, 'Library', 'Application Support'), fromEnv: undefined };
  if (ctx.platform === 'win32') return { fallback: path.join(ctx.home, 'AppData', 'Roaming'), fromEnv: envPath(ctx, 'APPDATA') };
  return { fallback: path.join(ctx.home, '.config'), fromEnv: envPath(ctx, 'XDG_CONFIG_HOME') };
}

function tasksUnder(path: ReturnType<typeof pathFor>, userDataDir: string): string {
  return path.join(userDataDir, 'User', 'globalStorage', CLINE_EXTENSION_ID, 'tasks');
}

/**
 * Cline keeps data in four shapes, so there are four kinds of root:
 *  - a plain root is a Cline data folder (`~/.cline/data`, `$CLINE_DATA_DIR`, `$CLINE_DIR/data`), read
 *    through `sessions/` (the SDK and CLI format) and `tasks/` (the standalone/JetBrains classic format);
 *  - `sessions:<dir>` is a session folder named by `$CLINE_SESSION_DATA_DIR`;
 *  - `editors:<dir>` is the folder an editor family keeps its user data in (`Code`, `Cursor`, ... below it);
 *  - `server:<dir>` is a remote-server install (`~/.vscode-server`, ...).
 * Every `CLINE_*` value is trimmed, as Cline does; a relative one is ignored.
 */
export const CLINE_ROOTS: RootSpec = {
  source: CLINE_SOURCE,

  defaults(ctx) {
    const path = pathFor(ctx.platform);
    const roots = [path.join(ctx.home, '.cline', 'data')];
    roots.push(kindedRoot(EDITORS, editorBase(ctx).fallback));
    for (const server of CLINE_REMOTE_SERVERS) roots.push(kindedRoot(SERVER, path.join(ctx.home, server)));
    return roots;
  },

  fromEnv(ctx) {
    const path = pathFor(ctx.platform);
    const roots: string[] = [];
    const sdkHome = clineSdkHome(ctx);
    if (sdkHome) roots.push(path.join(sdkHome, '.cline', 'data'));
    const dir = envPath(ctx, 'CLINE_DIR');
    if (dir) roots.push(path.join(dir, 'data'));
    const data = envPath(ctx, 'CLINE_DATA_DIR');
    if (data) roots.push(data);
    const sessions = envPath(ctx, 'CLINE_SESSION_DATA_DIR');
    if (sessions) roots.push(kindedRoot(SESSIONS, sessions));
    const editors = editorBase(ctx).fromEnv;
    if (editors) roots.push(kindedRoot(EDITORS, editors));
    return roots;
  },

  targets(root, ctx) {
    const path = pathFor(ctx.platform);
    const parsed = parseKindedRoot(root);
    switch (parsed.kind) {
      case SESSIONS:
        return [{ path: parsed.path, kind: 'sessions' }];
      case EDITORS:
        return CLINE_EDITOR_HOSTS.map((host) => ({ path: tasksUnder(path, path.join(parsed.path, host)), kind: 'tasks' }));
      case SERVER:
        return [{ path: tasksUnder(path, path.join(parsed.path, 'data')), kind: 'tasks' }];
      default:
        return [
          { path: path.join(root, 'sessions'), kind: 'sessions' },
          { path: path.join(root, 'tasks'), kind: 'tasks' },
        ];
    }
  },
};

