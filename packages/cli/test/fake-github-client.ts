import { GitHubNotFoundError, type Gist, type GitHubClient } from '../src/github/http.js';

export interface FakeGitHub extends GitHubClient {
  gists: Map<string, Gist>;
  calls: { method: string; id?: string; files?: Record<string, string | null> }[];
}

let next = 1;

export function fakeGitHubClient(login = 'octocat'): FakeGitHub {
  const gists = new Map<string, Gist>();
  const calls: FakeGitHub['calls'] = [];
  const copy = (gist: Gist): Gist => structuredClone(gist);
  return {
    gists,
    calls,
    async getUser() {
      calls.push({ method: 'getUser' });
      return { login, scopes: ['gist'] };
    },
    async listGists() {
      calls.push({ method: 'listGists' });
      return [...gists.values()].map((gist) => ({ ...copy(gist), files: Object.fromEntries(Object.keys(gist.files).map((name) => [name, { filename: name }])) }));
    },
    async getGist(id) {
      calls.push({ method: 'getGist', id });
      const gist = gists.get(id);
      if (!gist) throw new GitHubNotFoundError('Not Found', 404);
      return copy(gist);
    },
    async createGist(input) {
      const id = (next++).toString(16).padStart(20, 'a');
      calls.push({ method: 'createGist', id, files: input.files });
      const gist: Gist = {
        id,
        description: input.description,
        public: input.public,
        html_url: `https://gist.github.com/${login}/${id}`,
        files: Object.fromEntries(Object.entries(input.files).map(([name, content]) => [name, { filename: name, content }])),
      };
      gists.set(id, gist);
      return copy(gist);
    },
    async updateGist(id, files) {
      calls.push({ method: 'updateGist', id, files });
      const gist = gists.get(id);
      if (!gist) throw new GitHubNotFoundError('Not Found', 404);
      for (const [name, content] of Object.entries(files)) {
        if (content === null) delete gist.files[name];
        else gist.files[name] = { filename: name, content };
      }
      return copy(gist);
    },
  };
}
