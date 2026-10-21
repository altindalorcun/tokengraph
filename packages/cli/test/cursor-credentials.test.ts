import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountKeyFor, cursorStateDbPath, normalizeUserId, readCursorSignIn, readJwtClaims } from '../src/adapters/cursor/credentials.js';
import type { RootContext } from '../src/agent-roots.js';
import { fakeJwt, writeStateDb } from './fake-cursor.js';

describe('cursorStateDbPath', () => {
  it('macOS: Application Support under the home folder', () => {
    expect(cursorStateDbPath({ platform: 'darwin', env: {}, home: '/Users/me' })).toBe(
      '/Users/me/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
    );
  });

  it('Linux: XDG_CONFIG_HOME, else ~/.config; an empty variable counts as unset', () => {
    expect(cursorStateDbPath({ platform: 'linux', env: {}, home: '/home/me' })).toBe('/home/me/.config/Cursor/User/globalStorage/state.vscdb');
    expect(cursorStateDbPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/me' })).toBe('/xdg/Cursor/User/globalStorage/state.vscdb');
    expect(cursorStateDbPath({ platform: 'linux', env: { XDG_CONFIG_HOME: ' ' }, home: '/home/me' })).toBe('/home/me/.config/Cursor/User/globalStorage/state.vscdb');
  });

  it('Windows: %APPDATA%, else the default Roaming folder, with backslashes', () => {
    expect(cursorStateDbPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb',
    );
    expect(cursorStateDbPath({ platform: 'win32', env: {}, home: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb',
    );
  });
});

describe('user id and account key', () => {
  it('normalises auth0 subjects and keeps other WorkOS subjects verbatim', () => {
    expect(normalizeUserId('auth0|user_01ABC')).toBe('user_01ABC');
    expect(normalizeUserId('user_01ABC')).toBe('user_01ABC');
    expect(normalizeUserId('google-oauth2|1234567890')).toBe('google-oauth2|1234567890');
    expect(normalizeUserId('github|42')).toBe('github|42');
  });

  it('the account key is 16 hex digits of the SHA-256 of the normalised id, so both spellings agree', () => {
    expect(accountKeyFor('user_01ABC')).toMatch(/^[0-9a-f]{16}$/);
    expect(accountKeyFor(normalizeUserId('auth0|user_01ABC'))).toBe(accountKeyFor('user_01ABC'));
    expect(accountKeyFor('user_01ABC')).not.toBe(accountKeyFor('user_01ABD'));
    // sha256("abc") starts with ba7816bf8f01cfea.
    expect(accountKeyFor('abc')).toBe('ba7816bf8f01cfea');
  });
});

describe('readJwtClaims', () => {
  it('reads sub and exp from the payload', () => {
    expect(readJwtClaims(fakeJwt({ sub: 'auth0|user_X', exp: 1_900_000_000 }))).toEqual({ subject: 'auth0|user_X', expiresAt: 1_900_000_000 });
    expect(readJwtClaims(fakeJwt({ sub: 'user_X' }))).toEqual({ subject: 'user_X', expiresAt: null });
  });

  it('rejects anything that is not a JWT with a subject', () => {
    expect(readJwtClaims('not a jwt')).toBeNull();
    expect(readJwtClaims('a.b.c')).toBeNull();
    expect(readJwtClaims(fakeJwt({ nosub: true }))).toBeNull();
    expect(readJwtClaims(fakeJwt({ sub: '' }))).toBeNull();
    expect(readJwtClaims('<html>.<body>.</html>')).toBeNull();
  });
});

describe('readCursorSignIn with a fixture state.vscdb', () => {
  let root: string;
  let context: RootContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-cursor-cred-'));
    context = { platform: 'linux', env: { XDG_CONFIG_HOME: join(root, 'config') }, home: root };
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('reads the token and derives the id and key', async () => {
    const token = fakeJwt({ sub: 'auth0|user_01ABC', exp: 1_900_000_000 });
    writeStateDb(context, { 'cursorAuth/accessToken': token, 'cursorAuth/refreshToken': 'must-not-be-read', 'cursorAuth/cachedEmail': 'me@example.com' });
    const result = await readCursorSignIn(context);
    expect(result).toEqual({ kind: 'ok', token, userId: 'user_01ABC', accountKey: accountKeyFor('user_01ABC'), expiresAt: 1_900_000_000 });
  });

  it('does not modify the database', async () => {
    const path = writeStateDb(context, { 'cursorAuth/accessToken': fakeJwt({ sub: 'user_X' }) });
    const before = await readFile(path);
    await readCursorSignIn(context);
    expect((await readFile(path)).equals(before)).toBe(true);
  });

  it('accepts a JSON-quoted value', async () => {
    const token = fakeJwt({ sub: 'user_X' });
    writeStateDb(context, { 'cursorAuth/accessToken': JSON.stringify(token) });
    expect(await readCursorSignIn(context)).toMatchObject({ kind: 'ok', token });
  });

  it('reports not installed, signed out and unreadable without detail', async () => {
    expect(await readCursorSignIn(context)).toEqual({ kind: 'not-installed' });
    writeStateDb(context, { 'something/else': 'x' });
    expect(await readCursorSignIn(context)).toEqual({ kind: 'signed-out' });
    writeStateDb(context, { 'cursorAuth/accessToken': 'garbage' });
    expect(await readCursorSignIn(context)).toEqual({ kind: 'signed-out' });
    writeStateDb(context, { 'cursorAuth/accessToken': fakeJwt({ sub: 'user_X; Path=/' }) });
    expect(await readCursorSignIn(context)).toEqual({ kind: 'unreadable' });
  });

  it('a database that is not SQLite is unreadable, and an old Node without node:sqlite is skipped', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = cursorStateDbPath(context);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'this is not a database');
    expect(await readCursorSignIn(context)).toEqual({ kind: 'unreadable' });
    expect(await readCursorSignIn(context, { loadSqlite: async () => null })).toEqual({ kind: 'no-sqlite' });
  });
});
