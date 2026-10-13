import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { GitHubAuth } from '../config.js';
import { createGitHubClient, GitHubAuthError, type GitHubClient } from './http.js';

export type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync: ExecFile = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, { timeout: 10_000, windowsHide: true });
  return { stdout: String(stdout) };
};

// launchd and cron start jobs with a minimal PATH, so the usual install folders are checked too.
const COMMON_GH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin'];

export function findGh(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | null {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const dirs = [...(env['PATH'] ?? '').split(delimiter).filter(Boolean), ...(process.platform === 'win32' ? [] : COMMON_GH_DIRS)];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export async function ghToken(ghPath: string, exec: ExecFile = execFileAsync): Promise<string | null> {
  try {
    const token = (await exec(ghPath, ['auth', 'token', '--hostname', 'github.com'])).stdout.trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/**
 * For a gh-backed login the token is read from gh (once per client), so tokengraph never stores a copy of
 * a token that may carry `repo` scope, and a token gh refreshes keeps working.
 */
export function tokenProvider(auth: GitHubAuth, exec: ExecFile = execFileAsync): () => Promise<string> {
  if (auth.kind === 'token') return async () => auth.token;
  // One `gh auth token` per provider (so per publish), not one per request. A failure is not remembered.
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    const token = await ghToken(auth.ghPath, exec);
    if (!token) throw new GitHubAuthError(`The GitHub CLI at ${auth.ghPath} is not logged in any more.`, 401);
    cached = token;
    return token;
  };
}

export function clientFor(auth: GitHubAuth, options: { exec?: ExecFile; fetch?: typeof fetch } = {}): GitHubClient {
  return createGitHubClient({ token: tokenProvider(auth, options.exec), fetch: options.fetch });
}

/** Classic tokens list their scopes; fine-grained ones do not, and their gist access shows on first use. */
export function hasGistScope(scopes: string[] | null): boolean {
  return scopes === null || scopes.includes('gist');
}
