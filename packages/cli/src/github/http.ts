import { cliVersion } from '../bin-path.js';

export function githubApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['TOKENGRAPH_GITHUB_API'] ?? 'https://api.github.com').replace(/\/+$/, '');
}

export function githubWebBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['TOKENGRAPH_GITHUB_WEB'] ?? 'https://github.com').replace(/\/+$/, '');
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}
export class GitHubAuthError extends GitHubError {}
export class GitHubNotFoundError extends GitHubError {}
export class GitHubRateLimitError extends GitHubError {
  constructor(
    message: string,
    status: number,
    readonly resetAt: Date | null,
  ) {
    super(message, status);
  }
}

export interface GistFile {
  filename: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

export interface Gist {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  files: Record<string, GistFile | null>;
}

export interface GitHubUser {
  login: string;
  /** Classic OAuth scopes; null when GitHub does not say (fine-grained tokens). */
  scopes: string[] | null;
}

export interface GitHubClient {
  getUser(): Promise<GitHubUser>;
  /** Every gist of the authenticated user, secret ones included; files carry no content. */
  listGists(): Promise<Gist[]>;
  getGist(id: string): Promise<Gist>;
  createGist(input: { description: string; public: boolean; files: Record<string, string> }): Promise<Gist>;
  /** Only the listed files change; null deletes a file. */
  updateGist(id: string, files: Record<string, string | null>): Promise<Gist>;
}

export interface GitHubClientOptions {
  token: () => Promise<string>;
  apiBase?: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

const MAX_GIST_PAGES = 30;

function rateLimitReset(headers: Headers): Date | null {
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000);
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return new Date(Date.now() + retryAfter * 1000);
  return null;
}

async function errorFor(response: Response): Promise<GitHubError> {
  let message = `GitHub answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') message = `${message}: ${body.message}`;
  } catch {
    // Not JSON; the status says enough.
  }
  const limited =
    response.status === 429 ||
    (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
  if (limited) return new GitHubRateLimitError(message, response.status, rateLimitReset(response.headers));
  if (response.status === 401) return new GitHubAuthError(message, 401);
  if (response.status === 404) return new GitHubNotFoundError(message, 404);
  return new GitHubError(message, response.status);
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const base = (options.apiBase ?? githubApiBase()).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? `tokengraph/${cliVersion()}`;

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
      Authorization: `Bearer ${await options.token()}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GitHubError(`Could not reach GitHub (${reason})`, 0);
    }
    if (!response.ok) throw await errorFor(response);
    return response;
  }

  async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await send(method, path, body)).json()) as T;
  }

  async function fillTruncated(gist: Gist): Promise<Gist> {
    for (const file of Object.values(gist.files)) {
      if (!file?.truncated || !file.raw_url) continue;
      let response: Response;
      try {
        // Raw URLs need no token, and it is not sent anywhere it is not needed.
        response = await doFetch(file.raw_url, { headers: { 'User-Agent': userAgent } });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new GitHubError(`Could not reach GitHub (${reason})`, 0);
      }
      if (!response.ok) throw await errorFor(response);
      file.content = await response.text();
      file.truncated = false;
    }
    return gist;
  }

  return {
    async getUser() {
      const response = await send('GET', '/user');
      const user = (await response.json()) as { login: string };
      const header = response.headers.get('x-oauth-scopes');
      const scopes = header === null ? null : header.split(',').map((scope) => scope.trim()).filter(Boolean);
      return { login: user.login, scopes };
    },
    async listGists() {
      const all: Gist[] = [];
      for (let page = 1; page <= MAX_GIST_PAGES; page += 1) {
        const batch = await sendJson<Gist[]>('GET', `/gists?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    async getGist(id) {
      return fillTruncated(await sendJson<Gist>('GET', `/gists/${encodeURIComponent(id)}`));
    },
    async createGist(input) {
      const files = Object.fromEntries(Object.entries(input.files).map(([name, content]) => [name, { content }]));
      return sendJson<Gist>('POST', '/gists', { description: input.description, public: input.public, files });
    },
    async updateGist(id, files) {
      const body = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, content === null ? null : { content }]));
      return sendJson<Gist>('PATCH', `/gists/${encodeURIComponent(id)}`, { files: body });
    },
  };
}
