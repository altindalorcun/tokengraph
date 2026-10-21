import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { pathFor, type RootContext } from '../../agent-roots.js';
import { loadSqlite } from '../opencode/sqlite.js';

/**
 * Cursor's own sign-in on this machine, read so tokengraph can fetch the user's own usage export from
 * cursor.com (docs/agents/cursor-usage.md, "Automatic history"). The access token lives in Cursor's
 * `state.vscdb`, a SQLite file Cursor keeps open, so it is opened read-only and only the one row is selected.
 *
 * The token, the cookie built from it and the user id are secrets of the user's account: they stay in
 * memory for one request, are never written anywhere (not the ledger, config or state file), never
 * logged, and never put in an error message. Only {@link accountKeyFor}'s hash may be stored.
 */

const TOKEN_KEY = 'cursorAuth/accessToken';

/** Cursor's `state.vscdb`. Pure: the platform, environment and home folder are injected. */
export function cursorStateDbPath(ctx: RootContext): string {
  const path = pathFor(ctx.platform);
  const tail = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Application Support', ...tail);
  if (ctx.platform === 'win32') {
    const appData = ctx.env['APPDATA']?.trim();
    return path.join(appData ? appData : path.join(ctx.home, 'AppData', 'Roaming'), ...tail);
  }
  const xdg = ctx.env['XDG_CONFIG_HOME']?.trim();
  return path.join(xdg ? xdg : path.join(ctx.home, '.config'), ...tail);
}

/**
 * The user id Cursor's cookie wants. Auth0 subjects (`auth0|user_X`) are `user_X`; any other WorkOS
 * subject (`google-oauth2|...`, `github|...`) is kept verbatim.
 */
export function normalizeUserId(subject: string): string {
  return subject.startsWith('auth0|') ? subject.slice('auth0|'.length) : subject;
}

/** The first 16 hex digits of the SHA-256 of the normalised user id: the only thing about the account that is ever stored. */
export function accountKeyFor(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** `sub` and `exp` (epoch seconds) from a JWT's payload. The signature is not checked: the server does that. */
export function readJwtClaims(jwt: string): { subject: string; expiresAt: number | null } | null {
  if (!JWT.test(jwt)) return null;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const subject = payload['sub'];
    if (typeof subject !== 'string' || subject.trim() === '') return null;
    const exp = payload['exp'];
    return { subject: subject.trim(), expiresAt: typeof exp === 'number' && Number.isFinite(exp) ? exp : null };
  } catch {
    return null;
  }
}

export type CursorSignIn =
  | { kind: 'ok'; token: string; userId: string; accountKey: string; expiresAt: number | null }
  /** No Cursor database here: Cursor is not installed, or has never been run. */
  | { kind: 'not-installed' }
  /** The database exists but holds no usable token: signed out. */
  | { kind: 'signed-out' }
  /** The database could not be opened or read. No detail is kept: it could echo the row. */
  | { kind: 'unreadable' }
  /** This Node has no `node:sqlite` (before 22.13). */
  | { kind: 'no-sqlite' };

export interface CredentialDeps {
  loadSqlite: typeof loadSqlite;
  exists: (path: string) => Promise<boolean>;
}

const DEFAULT_DEPS: CredentialDeps = {
  loadSqlite,
  exists: async (path) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
};

function cellText(value: unknown): string | null {
  const text = typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null;
  if (text === null) return null;
  const trimmed = text.trim();
  // Some stores keep the value JSON-quoted.
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed.trim() : null;
    } catch {
      return null;
    }
  }
  return trimmed;
}

/** Reads the sign-in. Never writes to Cursor's database, never uses `immutable=1` (it would ignore the write-ahead log and could return a stale token). */
export async function readCursorSignIn(ctx: RootContext, partial: Partial<CredentialDeps> = {}): Promise<CursorSignIn> {
  const deps = { ...DEFAULT_DEPS, ...partial };
  const dbPath = cursorStateDbPath(ctx);
  if (!(await deps.exists(dbPath))) return { kind: 'not-installed' };
  const DatabaseSync = await deps.loadSqlite();
  if (!DatabaseSync) return { kind: 'no-sqlite' };
  let raw: unknown;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    try {
      raw = (db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(TOKEN_KEY) as { value?: unknown } | undefined)?.value;
    } finally {
      db.close();
    }
  } catch {
    return { kind: 'unreadable' };
  }
  const token = cellText(raw);
  if (!token) return { kind: 'signed-out' };
  const claims = readJwtClaims(token);
  if (!claims) return { kind: 'signed-out' };
  const userId = normalizeUserId(claims.subject);
  // The id goes into a Cookie header: anything outside the ordinary id alphabet is not sent.
  if (!/^[A-Za-z0-9_|.-]{1,200}$/.test(userId)) return { kind: 'unreadable' };
  return { kind: 'ok', token, userId, accountKey: accountKeyFor(userId), expiresAt: claims.expiresAt };
}
