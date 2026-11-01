import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyLedger, mergeProjectRoots } from '../src/ledger.js';
import { normaliseFolder, refreshProjectRoots, resolveProjectRoot, type RootDeps } from '../src/project-roots.js';

const HOME = '/Users/me';

function deps(git: Record<string, string>, existing: string[] = []): Partial<RootDeps> {
  return {
    home: HOME,
    readGit: async (dir) => git[dir] ?? null,
    exists: async (dir) => existing.includes(dir) || dir in git,
  };
}

describe('normaliseFolder', () => {
  it('compares Windows and POSIX forms and drops a trailing slash', () => {
    expect(normaliseFolder('C:\\Users\\me\\work\\')).toBe('C:/Users/me/work');
    expect(normaliseFolder('/Users/me/work/')).toBe('/Users/me/work');
    expect(normaliseFolder('/')).toBe('/');
  });

  it('spells a drive letter one way', () => {
    expect(normaliseFolder('c:\\Users\\me')).toBe('C:/Users/me');
    expect(normaliseFolder('C:/Users/me')).toBe('C:/Users/me');
  });
});

describe('resolveProjectRoot', () => {
  it('a subfolder resolves to the repo', async () => {
    expect(await resolveProjectRoot(`${HOME}/code/app/packages/web`, deps({ [`${HOME}/code/app`]: 'dir' }))).toBe(`${HOME}/code/app`);
  });

  it('a deleted worktree inside a repo resolves to the repo', async () => {
    expect(await resolveProjectRoot(`${HOME}/code/app/.claude/worktrees/gone`, deps({ [`${HOME}/code/app`]: 'dir' }))).toBe(`${HOME}/code/app`);
  });

  it('a linked worktree resolves to the main repo', async () => {
    const worktree = `${HOME}/elsewhere/feature`;
    expect(await resolveProjectRoot(`${worktree}/src`, deps({ [worktree]: `gitdir: ${HOME}/code/app/.git/worktrees/feature\n` }))).toBe(`${HOME}/code/app`);
  });

  it('a relative gitdir of a linked worktree resolves too', async () => {
    const worktree = `${HOME}/code/app/wt/feature`;
    expect(await resolveProjectRoot(worktree, deps({ [worktree]: 'gitdir: ../../.git/worktrees/feature\n' }))).toBe(`${HOME}/code/app`);
  });

  it('a submodule stays its own root', async () => {
    const submodule = `${HOME}/code/app/vendor/lib`;
    expect(await resolveProjectRoot(`${submodule}/src`, deps({ [submodule]: 'gitdir: ../../.git/modules/vendor/lib\n', [`${HOME}/code/app`]: 'dir' }))).toBe(submodule);
  });

  it('a folder with no repo is its own root', async () => {
    expect(await resolveProjectRoot(`${HOME}/notes/2026`, deps({}))).toBe(`${HOME}/notes/2026`);
  });

  it('never accepts a repo in the home folder: a dotfiles repo must not swallow every project', async () => {
    expect(await resolveProjectRoot(`${HOME}/work/x`, deps({ [HOME]: 'dir' }))).toBe(`${HOME}/work/x`);
    expect(await resolveProjectRoot(HOME, deps({ [HOME]: 'dir' }))).toBe(HOME);
  });

  it('knows the home folder however it is spelled', async () => {
    const repoInHome = { '/Users/me': 'dir' as const };
    expect(await resolveProjectRoot('/users/me/proj', { ...deps(repoInHome), platform: 'darwin', readGit: async (dir) => (dir.toLowerCase() === '/users/me' ? 'dir' : null) })).toBe('/users/me/proj');
    expect(await resolveProjectRoot('c:\\Users\\me\\proj', { home: 'C:\\Users\\me', platform: 'win32', readGit: async (dir) => (dir === 'C:/Users/me' ? 'dir' : null) })).toBe('C:/Users/me/proj');
    expect(await resolveProjectRoot('/data/me/proj/sub', { home: '/home/me', platform: 'linux', realpath: async (path) => (path === '/home/me' ? '/data/me' : null), readGit: async (dir) => (dir === '/data/me' ? 'dir' : null) })).toBe('/data/me/proj/sub');
  });

  it('keeps case apart where the disk does', async () => {
    expect(await resolveProjectRoot('/Home/me/proj', { home: '/home/me', platform: 'linux', readGit: async (dir) => (dir === '/Home/me' ? 'dir' : null) })).toBe('/Home/me');
  });

  it('uses the one real spelling of a folder that exists, so a symlink does not split a project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokengraph-link-'));
    try {
      await mkdir(join(root, 'real', '.git'), { recursive: true });
      await symlink(join(root, 'real'), join(root, 'link'));
      const home = join(root, 'home');
      const real = normaliseFolder(realpathSync(join(root, 'real')));
      expect(await resolveProjectRoot(join(root, 'link'), { home })).toBe(real);
      expect(await resolveProjectRoot(join(root, 'real'), { home })).toBe(real);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops at home instead of looking above it', async () => {
    const seen: string[] = [];
    await resolveProjectRoot(`${HOME}/a/b`, { home: HOME, readGit: async (dir) => (seen.push(dir), null) });
    expect(seen).toEqual([`${HOME}/a/b`, `${HOME}/a`]);
  });

  it('walks up outside home, but not into the filesystem root', async () => {
    expect(await resolveProjectRoot('/srv/app/src', deps({ '/srv/app': 'dir' }))).toBe('/srv/app');
    expect(await resolveProjectRoot('/srv/app/src', deps({ '/': 'dir' }))).toBe('/srv/app/src');
  });

  it('treats Windows separators like any other', async () => {
    const found = await resolveProjectRoot('C:\\Users\\me\\code\\app\\src', { home: 'C:\\Users\\me', readGit: async (dir) => (dir === 'C:/Users/me/code/app' ? 'dir' : null) });
    expect(found).toBe('C:/Users/me/code/app');
  });

  it('reads a real .git folder and a real .git file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokengraph-roots-'));
    try {
      await mkdir(join(root, 'repo', '.git'), { recursive: true });
      await mkdir(join(root, 'repo', 'src'), { recursive: true });
      await mkdir(join(root, 'linked'), { recursive: true });
      await writeFile(join(root, 'linked', '.git'), `gitdir: ${join(root, 'repo', '.git', 'worktrees', 'linked')}\n`);
      const home = join(root, 'home');
      const repo = normaliseFolder(realpathSync(join(root, 'repo')));
      expect(await resolveProjectRoot(join(root, 'repo', 'src'), { home })).toBe(repo);
      expect(normaliseFolder(realpathSync(await resolveProjectRoot(join(root, 'linked'), { home })))).toBe(repo);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('refreshProjectRoots', () => {
  it('records a new folder', async () => {
    const ledger = await refreshProjectRoots(emptyLedger(), [`${HOME}/code/app/src`], deps({ [`${HOME}/code/app`]: 'dir' }));
    expect(ledger.projects?.roots).toEqual({ [`${HOME}/code/app/src`]: `${HOME}/code/app` });
  });

  it('keeps the root of a folder that is gone', async () => {
    const stored = mergeProjectRoots(emptyLedger(), { [`${HOME}/old/repo/src`]: `${HOME}/old/repo` });
    const ledger = await refreshProjectRoots(stored, [`${HOME}/old/repo/src`], deps({}));
    expect(ledger.projects?.roots[`${HOME}/old/repo/src`]).toBe(`${HOME}/old/repo`);
  });

  it('recomputes a folder that still exists, so a later git init is picked up', async () => {
    const folder = `${HOME}/code/app/src`;
    const stored = mergeProjectRoots(emptyLedger(), { [folder]: folder });
    const ledger = await refreshProjectRoots(stored, [folder], deps({ [`${HOME}/code/app`]: 'dir' }, [folder]));
    expect(ledger.projects?.roots[folder]).toBe(`${HOME}/code/app`);
  });
});
