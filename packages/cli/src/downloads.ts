import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';

export interface DownloadsIO {
  readFile: (path: string) => string | null;
  /** The data of one registry value under HKCU, or null. */
  readRegistry: (key: string, value: string) => string | null;
}

const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
// FOLDERID_Downloads; the registry has no named value for it.
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';

const defaultIO: DownloadsIO = {
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  readRegistry: (key, value) => {
    try {
      const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(value));
      return line?.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  },
};

/** %VAR% expansion, case-insensitive like Windows itself. An unknown variable leaves the path unusable. */
function expandWindows(value: string, env: NodeJS.ProcessEnv): string | null {
  let unknown = false;
  const expanded = value.replace(/%([^%]+)%/g, (_, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    const found = key === undefined ? undefined : env[key];
    if (found === undefined) unknown = true;
    return found ?? '';
  });
  return unknown || !win32.isAbsolute(expanded) ? null : expanded;
}

/** An XDG user-dirs value: "$HOME/…" or an absolute path. A value equal to $HOME means the folder is disabled. */
function resolveXdg(raw: string, home: string): string | null {
  const value = raw.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
  const resolved = value.replace(/^\$(HOME|\{HOME\})(?=\/|$)/, home);
  if (!isAbsolute(resolved)) return null;
  const normalized = posix.normalize(resolved).replace(/\/$/, '');
  return normalized === posix.normalize(home).replace(/\/$/, '') ? null : normalized;
}

/**
 * Where the OS keeps the user's downloads, or null when it does not say. The folder name is localised on
 * Linux (`~/İndirilenler`) and can be moved on Windows, so `~/Downloads` alone is not enough. macOS always
 * keeps `~/Downloads` on disk and only shows a translated name in Finder. The caller checks that it exists.
 */
export function downloadsDir(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, io: DownloadsIO = defaultIO): string | null {
  if (platform === 'darwin') return posix.join(home, 'Downloads');
  if (platform === 'win32') {
    const value = io.readRegistry(SHELL_FOLDERS, DOWNLOADS_GUID);
    return value ? expandWindows(value, env) : null;
  }
  if (env['XDG_DOWNLOAD_DIR']) return resolveXdg(env['XDG_DOWNLOAD_DIR'], home);
  const configHome = env['XDG_CONFIG_HOME'] && isAbsolute(env['XDG_CONFIG_HOME']) ? env['XDG_CONFIG_HOME'] : posix.join(home, '.config');
  const file = io.readFile(posix.join(configHome, 'user-dirs.dirs'));
  const line = file?.split('\n').find((l) => /^\s*XDG_DOWNLOAD_DIR\s*=/.test(l));
  return line ? resolveXdg(line.slice(line.indexOf('=') + 1).trim(), home) : null;
}
