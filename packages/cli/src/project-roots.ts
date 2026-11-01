import { realpath as fsRealpath } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { mergeProjectRoots, type Ledger } from './ledger.js';

export interface RootDeps {
  home: string;
  /** What `<dir>/.git` is: 'dir' for a folder, the file's text for a file, null when there is none. */
  readGit: (dir: string) => Promise<'dir' | string | null>;
  exists: (dir: string) => Promise<boolean>;
  /** The disk's own spelling of a path that exists, else null. */
  realpath: (path: string) => Promise<string | null>;
  platform: NodeJS.Platform;
}

const MAX_GIT_FILE = 4096;

async function readGit(dir: string): Promise<'dir' | string | null> {
  try {
    const path = `${dir}/.git`;
    const info = await stat(path);
    if (info.isDirectory()) return 'dir';
    return info.isFile() && info.size <= MAX_GIT_FILE ? await readFile(path, 'utf8') : null;
  } catch {
    return null;
  }
}

async function exists(dir: string): Promise<boolean> {
  return stat(dir).then((info) => info.isDirectory(), () => false);
}

const nativeRealpath = promisify(fsRealpath.native);

/** The native call, because only it returns the disk's own case on macOS and Windows. */
async function realpath(path: string): Promise<string | null> {
  return nativeRealpath(path).catch(() => null);
}

/** One spelling per folder: `/` separators, no trailing slash, an upper-case drive letter. */
export function normaliseFolder(folder: string): string {
  const unified = folder.trim().replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  return unified.length > 1 ? unified.replace(/\/$/, '') : unified;
}

/** Whether two spellings can name one folder: macOS and Windows disks ignore case by default. */
function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parent(dir: string): string | null {
  // Stops below `/` and `C:`: a repo at the very top of a disk says nothing about the folder inside it.
  const up = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
  return up === '' || /^[a-z]:$/i.test(up) ? null : up;
}

/** The main repo of a linked worktree, whose `.git` file points into `<repo>/.git/worktrees/<name>`. A submodule's points elsewhere. */
function mainRepo(gitFile: string, dir: string): string | null {
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile)?.[1];
  if (!gitdir) return null;
  const spelled = normaliseFolder(gitdir);
  const absolute = spelled.startsWith('/') || /^[a-z]:/i.test(spelled) ? spelled : posix.normalize(`${dir}/${spelled}`);
  const cut = absolute.indexOf('/.git/worktrees/');
  return cut > 0 ? absolute.slice(0, cut) : null;
}

/**
 * The project a folder belongs to: the nearest repo above it, or the folder itself. The walk works on the path, so a
 * deleted worktree inside a repo still reaches that repo. A folder that exists is first read in the disk's own spelling, so
 * a symlink or a different case does not split a project. It never reads the home folder, however that is spelled: a
 * dotfiles repo there would otherwise swallow every project. Only `.git` is looked at, and `git` is never started.
 */
export async function resolveProjectRoot(folder: string, deps: Partial<RootDeps> = {}): Promise<string> {
  const read = deps.readGit ?? readGit;
  const real = deps.realpath ?? realpath;
  const platform = deps.platform ?? process.platform;
  const homeFolder = deps.home ?? homedir();
  const homes = [homeFolder, (await real(homeFolder)) ?? homeFolder].map(normaliseFolder);
  const isHome = (dir: string): boolean => homes.some((home) => sameFolder(dir, home, platform));
  const spelled = normaliseFolder(folder);
  const start = normaliseFolder((await real(spelled)) ?? spelled);
  for (let dir: string | null = start; dir !== null && !isHome(dir); dir = parent(dir)) {
    const git = await read(dir);
    if (git === 'dir') return dir;
    if (git !== null) return mainRepo(git, dir) ?? dir;
  }
  return start;
}

/** Works out each folder's root. A folder that is gone keeps the root it had: it can no longer be looked at. */
export async function refreshProjectRoots(ledger: Ledger, folders: Iterable<string>, deps: Partial<RootDeps> = {}): Promise<Ledger> {
  const isThere = deps.exists ?? exists;
  const roots: Record<string, string> = {};
  for (const folder of new Set(folders)) {
    const stored = ledger.projects?.roots[folder];
    if (stored !== undefined && !(await isThere(folder))) continue;
    roots[folder] = await resolveProjectRoot(folder, deps);
  }
  return mergeProjectRoots(ledger, roots);
}
