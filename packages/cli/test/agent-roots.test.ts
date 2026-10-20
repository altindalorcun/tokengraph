import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  absolutePath,
  candidateRoots,
  environmentOverrides,
  envText,
  expandHome,
  FileDeduper,
  kindedRoot,
  parseKindedRoot,
  planScan,
  windowsShellPath,
  type RootContext,
  type RootSpec,
} from '../src/agent-roots.js';

const linux = (env: Record<string, string | undefined> = {}, home = '/home/me'): RootContext => ({ platform: 'linux', env, home });
const windows = (env: Record<string, string | undefined> = {}, home = 'C:\\Users\\me'): RootContext => ({ platform: 'win32', env, home });

describe('environment values', () => {
  it('trims and treats an empty value as unset', () => {
    expect(envText(linux({ A: '  /x  ' }), 'A')).toBe('/x');
    expect(envText(linux({ A: '   ' }), 'A')).toBeUndefined();
    expect(envText(linux({ A: '' }), 'A')).toBeUndefined();
    expect(envText(linux(), 'A')).toBeUndefined();
  });

  it('expands a leading ~, ~/ and (on Windows only) ~\\', () => {
    expect(expandHome(linux(), '~')).toBe('/home/me');
    expect(expandHome(linux(), '~/p')).toBe('/home/me/p');
    expect(expandHome(linux(), '~\\p')).toBe('~\\p');
    expect(expandHome(linux(), '~other')).toBe('~other');
    expect(expandHome(windows(), '~\\p')).toBe('C:\\Users\\me\\p');
    expect(expandHome(windows(), '~/p')).toBe('C:\\Users\\me\\p');
  });

  it('keeps absolute values, strips a trailing separator, and ignores relative ones', () => {
    expect(absolutePath(linux(), ' /a/b/ ')).toBe('/a/b');
    expect(absolutePath(linux(), '/')).toBe('/');
    expect(absolutePath(linux(), '~/p')).toBe('/home/me/p');
    expect(absolutePath(linux(), 'rel/path')).toBeUndefined();
    expect(absolutePath(linux(), './rel')).toBeUndefined();
    expect(absolutePath(linux(), '')).toBeUndefined();
    expect(absolutePath(windows(), 'D:\\data\\')).toBe('D:\\data');
    expect(absolutePath(windows(), 'rel\\path')).toBeUndefined();
  });

  it('reads file:// URLs and Git Bash drive paths only when asked', () => {
    expect(absolutePath(linux(), 'file:///srv/pi%20data', { fileUrl: true })).toBe('/srv/pi data');
    expect(absolutePath(linux(), 'file:///srv/pi')).toBeUndefined();
    expect(absolutePath(windows(), 'file:///D:/pi/agent', { fileUrl: true })).toBe('D:\\pi\\agent');
    expect(absolutePath(linux(), 'file://remote/share/x', { fileUrl: true })).toBeUndefined();
    expect(windowsShellPath('/c/Users/me')).toBe('C:\\Users\\me');
    expect(windowsShellPath('/mnt/d')).toBe('D:\\');
    expect(windowsShellPath('C:\\x')).toBe('C:\\x');
    expect(absolutePath(windows(), '/c/Users/me/pi', { shellPaths: true })).toBe('C:\\Users\\me\\pi');
    expect(absolutePath(linux(), '/c/Users/me/pi', { shellPaths: true })).toBe('/c/Users/me/pi');
  });

  it('tells kinded roots from plain ones, including Windows drive letters', () => {
    expect(parseKindedRoot(kindedRoot('desktop', 'C:\\Users\\me\\Claude'))).toEqual({ kind: 'desktop', path: 'C:\\Users\\me\\Claude' });
    expect(parseKindedRoot('C:\\Users\\me\\.claude')).toEqual({ kind: '', path: 'C:\\Users\\me\\.claude' });
    expect(parseKindedRoot('/home/me/.claude')).toEqual({ kind: '', path: '/home/me/.claude' });
  });
});

const SPEC: RootSpec = {
  source: 'codex-cli',
  defaults: (ctx) => [`${ctx.home}/.agent`],
  fromEnv: (ctx) => (ctx.env['AGENT_HOME'] ? [ctx.env['AGENT_HOME']] : []),
  targets: (root) => [{ path: `${root}/sessions`, kind: 'sessions' }],
};

describe('candidateRoots', () => {
  it('lists defaults, then the environment, then remembered roots, once each, keeping the first origin', () => {
    const ctx = linux({ AGENT_HOME: '/work/agent' });
    expect(candidateRoots(SPEC, ctx, ['/old/agent', '/work/agent', '/home/me/.agent'])).toEqual([
      { root: '/home/me/.agent', origin: 'default' },
      { root: '/work/agent', origin: 'env' },
      { root: '/old/agent', origin: 'remembered' },
    ]);
  });

  it('compares Windows roots without regard to case or separators style', () => {
    const ctx = windows({ AGENT_HOME: 'c:\\users\\me\\.AGENT' });
    const spec: RootSpec = { ...SPEC, defaults: () => ['C:\\Users\\me\\.agent'] };
    expect(candidateRoots(spec, ctx)).toHaveLength(1);
  });

  it('remembers only environment roots that are not already a default', () => {
    expect(environmentOverrides(SPEC, linux({ AGENT_HOME: '/home/me/.agent' }))).toEqual([]);
    expect(environmentOverrides(SPEC, linux({ AGENT_HOME: '/work/agent' }))).toEqual(['/work/agent']);
    expect(environmentOverrides(SPEC, linux())).toEqual([]);
  });
});

describe('planScan', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-roots-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const spec: RootSpec = {
    source: 'codex-cli',
    defaults: () => [],
    fromEnv: () => [],
    targets: (root) => [{ path: join(root, 'sessions'), kind: 'sessions' }],
  };

  it('lists a folder reached through a symlink once, under the first root that named it', async () => {
    const real = join(dir, 'real');
    await mkdir(join(real, 'sessions'), { recursive: true });
    const link = join(dir, 'link');
    try {
      await symlink(real, link, 'dir');
    } catch {
      return; // Creating symlinks needs a privilege on some Windows setups.
    }
    const plan = await planScan(spec, linux(), [real, link, `${real}/`]);
    expect(plan.filter((target) => target.exists)).toHaveLength(1);
    expect(plan[0]).toMatchObject({ root: real, origin: 'remembered', exists: true });
  });

  it('lists missing targets as missing, once each', async () => {
    const plan = await planScan(spec, linux(), [join(dir, 'gone'), join(dir, 'gone')]);
    expect(plan).toEqual([{ path: join(dir, 'gone', 'sessions'), kind: 'sessions', root: join(dir, 'gone'), origin: 'remembered', exists: false }]);
  });
});

describe('FileDeduper', () => {
  it('accepts a file once however it is spelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tg-dedup-'));
    try {
      await mkdir(join(dir, 'a'), { recursive: true });
      await writeFile(join(dir, 'a', 'f.jsonl'), '{}');
      const files = new FileDeduper();
      expect(await files.first(join(dir, 'a', 'f.jsonl'))).toBe(true);
      expect(await files.first(join(dir, 'a', '..', 'a', 'f.jsonl'))).toBe(false);
      expect(await files.first(join(dir, 'a', 'other.jsonl'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
