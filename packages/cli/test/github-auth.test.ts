import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findGh, ghToken, hasGistScope, tokenProvider } from '../src/github/auth.js';
import { GitHubAuthError } from '../src/github/http.js';

describe('findGh', () => {
  it('finds gh on PATH', () => {
    const env = { PATH: ['/nope', '/tools/bin'].join(delimiter) };
    expect(findGh(env, (path) => path === join('/tools/bin', process.platform === 'win32' ? 'gh.exe' : 'gh'))).toBe(
      join('/tools/bin', process.platform === 'win32' ? 'gh.exe' : 'gh'),
    );
  });

  it('falls back to the usual install folders (launchd has a minimal PATH)', () => {
    if (process.platform === 'win32') return;
    expect(findGh({ PATH: '/usr/bin' }, (path) => path === '/opt/homebrew/bin/gh')).toBe('/opt/homebrew/bin/gh');
  });

  it('returns null when gh is not installed', () => {
    expect(findGh({ PATH: '/nope' }, () => false)).toBeNull();
  });
});

describe('ghToken', () => {
  it('reads and trims the token', async () => {
    expect(await ghToken('/bin/gh', async (_file, args) => {
      expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
      return { stdout: 'gho_abc\n' };
    })).toBe('gho_abc');
  });

  it('returns null when gh is logged out or fails', async () => {
    expect(await ghToken('/bin/gh', async () => { throw new Error('not logged in'); })).toBeNull();
    expect(await ghToken('/bin/gh', async () => ({ stdout: '\n' }))).toBeNull();
  });
});

describe('tokenProvider', () => {
  it('returns a stored token', async () => {
    expect(await tokenProvider({ kind: 'token', token: 'gho_x' })()).toBe('gho_x');
  });

  it('asks gh at use time and fails as an auth error when gh logged out', async () => {
    expect(await tokenProvider({ kind: 'gh', ghPath: '/bin/gh' }, async () => ({ stdout: 'gho_y' }))()).toBe('gho_y');
    await expect(tokenProvider({ kind: 'gh', ghPath: '/bin/gh' }, async () => { throw new Error('x'); })()).rejects.toBeInstanceOf(GitHubAuthError);
  });
});

describe('tokenProvider memo', () => {
  it('asks gh once for the life of the provider', async () => {
    let asked = 0;
    const provide = tokenProvider({ kind: 'gh', ghPath: '/bin/gh' }, async () => {
      asked += 1;
      return { stdout: 'gho_y\n' };
    });
    expect(await provide()).toBe('gho_y');
    expect(await provide()).toBe('gho_y');
    expect(asked).toBe(1);
  });

  it('does not remember a failure', async () => {
    let asked = 0;
    const provide = tokenProvider({ kind: 'gh', ghPath: '/bin/gh' }, async () => {
      asked += 1;
      if (asked === 1) throw new Error('not logged in');
      return { stdout: 'gho_z' };
    });
    await expect(provide()).rejects.toBeInstanceOf(GitHubAuthError);
    expect(await provide()).toBe('gho_z');
  });
});

describe('hasGistScope', () => {
  it('accepts gist, or unknown scopes (fine-grained tokens)', () => {
    expect(hasGistScope(['repo', 'gist'])).toBe(true);
    expect(hasGistScope(null)).toBe(true);
    expect(hasGistScope(['repo', 'read:org'])).toBe(false);
  });
});
