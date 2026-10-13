import { describe, expect, it } from 'vitest';
import {
  createGitHubClient,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  githubApiBase,
} from '../src/github/http.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responses(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init });

const client = (fetch: typeof globalThis.fetch) =>
  createGitHubClient({ token: async () => 'gho_test', apiBase: 'https://api.test', fetch, userAgent: 'tokengraph/test' });

describe('githubApiBase', () => {
  it('defaults to api.github.com and honours the override', () => {
    expect(githubApiBase({})).toBe('https://api.github.com');
    expect(githubApiBase({ TOKENGRAPH_GITHUB_API: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
  });
});

describe('GitHub client', () => {
  it('sends the auth and API headers', async () => {
    const { fetch, calls } = fakeFetch(() => json({ login: 'octocat' }, { headers: { 'x-oauth-scopes': 'gist, read:org' } }));
    expect(await client(fetch).getUser()).toEqual({ login: 'octocat', scopes: ['gist', 'read:org'] });
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe('https://api.test/user');
    expect(headers.get('authorization')).toBe('Bearer gho_test');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toBe('tokengraph/test');
  });

  it('reports unknown scopes as null (fine-grained tokens send no header)', async () => {
    const { fetch } = fakeFetch(() => json({ login: 'octocat' }));
    expect((await client(fetch).getUser()).scopes).toBeNull();
  });

  it('pages through every gist', async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `g${n}-${i}`, description: null, public: true, html_url: '', files: {} }));
    const { fetch, calls } = fakeFetch((call) => json(call.url.endsWith('&page=1') ? page(1, 100) : page(2, 3)));
    expect(await client(fetch).listGists()).toHaveLength(103);
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/gists?per_page=100&page=1', 'https://api.test/gists?per_page=100&page=2']);
  });

  it('fills a truncated file from its raw URL without sending the token there', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.startsWith('https://raw.test')
        ? new Response('full content')
        : json({ id: 'abc', description: null, public: false, html_url: '', files: { 'a.json': { filename: 'a.json', content: 'cut', truncated: true, raw_url: 'https://raw.test/a.json' } } }),
    );
    const gist = await client(fetch).getGist('abc');
    expect(gist.files['a.json']!.content).toBe('full content');
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBeNull();
  });

  it('creates and updates gists with JSON bodies', async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: 'new', description: 'd', public: true, html_url: 'h', files: {} }));
    await client(fetch).createGist({ description: 'd', public: true, files: { 'a.svg': '<svg/>' } });
    await client(fetch).updateGist('new', { 'a.svg': '<svg></svg>', 'old.svg': null });
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ description: 'd', public: true, files: { 'a.svg': { content: '<svg/>' } } });
    expect(calls[1]!.url).toBe('https://api.test/gists/new');
    expect(calls[1]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ files: { 'a.svg': { content: '<svg></svg>' }, 'old.svg': null } });
  });

  it('maps 401, 404 and rate limits to typed errors', async () => {
    await expect(client(fakeFetch(() => json({ message: 'Bad credentials' }, { status: 401 })).fetch).getUser()).rejects.toBeInstanceOf(GitHubAuthError);
    await expect(client(fakeFetch(() => json({ message: 'Not Found' }, { status: 404 })).fetch).getGist('x')).rejects.toBeInstanceOf(GitHubNotFoundError);
    const limited = fakeFetch(() => json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } }));
    const error = await client(limited.fetch).getUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt?.getTime()).toBe(1_800_000_000_000);
    const secondary = fakeFetch(() => json({ message: 'secondary rate limit' }, { status: 429, headers: { 'retry-after': '60' } }));
    expect(await client(secondary.fetch).getUser().catch((e: unknown) => e)).toBeInstanceOf(GitHubRateLimitError);
  });

  it('wraps network failures in GitHubError with status 0', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const error = await client(fetch).getUser().catch((e: unknown) => e);
    expect((error as { status: number }).status).toBe(0);
  });
});
