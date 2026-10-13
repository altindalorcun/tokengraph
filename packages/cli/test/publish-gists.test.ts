import { describe, expect, it } from 'vitest';
import { DATA_MARKER, ensureDataGist, ensureGraphGist, GRAPH_MARKER, gistLookup, graphGistReadme } from '../src/publish/gists.js';
import { fakeGitHubClient } from './fake-github-client.js';

const svgs = { [GRAPH_MARKER]: '<svg/>' };

describe('ensureDataGist', () => {
  it('creates a secret gist with the marker when none exists', async () => {
    const client = fakeGitHubClient();
    const { gist, created } = await ensureDataGist(client, undefined, gistLookup(client));
    expect(created).toBe(true);
    expect(gist.public).toBe(false);
    expect(Object.keys(gist.files)).toContain(DATA_MARKER);
  });

  it('finds an existing one by marker (second machine) and lists only once', async () => {
    const client = fakeGitHubClient();
    const first = await ensureDataGist(client, undefined, gistLookup(client));
    client.calls.length = 0;
    const lookup = gistLookup(client);
    const again = await ensureDataGist(client, undefined, lookup);
    await ensureGraphGist(client, undefined, lookup, svgs);
    expect(again.created).toBe(false);
    expect(again.gist.id).toBe(first.gist.id);
    expect(client.calls.filter((call) => call.method === 'listGists')).toHaveLength(1);
  });

  it('uses the cached id without listing', async () => {
    const client = fakeGitHubClient();
    const first = await ensureDataGist(client, undefined, gistLookup(client));
    client.calls.length = 0;
    await ensureDataGist(client, first.gist.id, gistLookup(client));
    expect(client.calls.map((call) => call.method)).toEqual(['getGist']);
  });
});

describe('ensureGraphGist', () => {
  it('creates a public gist with the rendered files', async () => {
    const client = fakeGitHubClient();
    const { gist, created, replacedCached } = await ensureGraphGist(client, undefined, gistLookup(client), svgs);
    expect([created, replacedCached, gist.public]).toEqual([true, false, true]);
    expect(gist.files[GRAPH_MARKER]?.content).toBe('<svg/>');
  });

  it('recreates a gist the user deleted and says so', async () => {
    const client = fakeGitHubClient();
    const first = await ensureGraphGist(client, undefined, gistLookup(client), svgs);
    client.gists.delete(first.gist.id);
    const again = await ensureGraphGist(client, first.gist.id, gistLookup(client), svgs);
    expect(again.created).toBe(true);
    expect(again.replacedCached).toBe(true);
    expect(again.gist.id).not.toBe(first.gist.id);
  });
});

describe('several gists with the marker', () => {
  it('picks the oldest, whatever order GitHub lists them in', async () => {
    const client = fakeGitHubClient();
    const make = (id: string, created_at: string) =>
      client.gists.set(id, { id, description: null, public: false, html_url: '', created_at, owner: { login: 'octocat' }, files: { [DATA_MARKER]: { filename: DATA_MARKER, content: 'x' } } });
    make('b'.repeat(20), '2026-03-01T00:00:00Z');
    make('a'.repeat(20), '2026-01-01T00:00:00Z');
    make('c'.repeat(20), '2026-02-01T00:00:00Z');
    const { gist } = await ensureDataGist(client, undefined, gistLookup(client), 'octocat');
    expect(gist.id).toBe('a'.repeat(20));
    const reversed = new Map([...client.gists].reverse());
    client.gists.clear();
    for (const [id, value] of reversed) client.gists.set(id, value);
    expect((await ensureDataGist(client, undefined, gistLookup(client), 'octocat')).gist.id).toBe('a'.repeat(20));
  });
});

describe('gists the logged-in account does not own', () => {
  function foreign(client: ReturnType<typeof fakeGitHubClient>, marker: string, extra: Record<string, unknown> = {}) {
    const id = 'f'.repeat(20);
    client.gists.set(id, { id, description: null, public: true, html_url: '', files: { [marker]: { filename: marker, content: 'x' } }, owner: { login: 'someone-else' }, ...extra });
    return id;
  }

  it('ignores a cached data gist id owned by someone else and makes a new one', async () => {
    const client = fakeGitHubClient('octocat');
    const id = foreign(client, DATA_MARKER);
    const { gist, created } = await ensureDataGist(client, id, gistLookup(client), 'octocat');
    expect(created).toBe(true);
    expect(gist.id).not.toBe(id);
  });

  it('ignores a cached graph gist id owned by someone else and says it replaced it', async () => {
    const client = fakeGitHubClient('octocat');
    const id = foreign(client, GRAPH_MARKER);
    const result = await ensureGraphGist(client, id, gistLookup(client), svgs, 'octocat');
    expect([result.created, result.replacedCached]).toEqual([true, true]);
    expect(result.gist.id).not.toBe(id);
  });

  it('compares the owner case-insensitively', async () => {
    const client = fakeGitHubClient('OctoCat');
    const first = await ensureDataGist(client, undefined, gistLookup(client), 'octocat');
    const again = await ensureDataGist(client, first.gist.id, gistLookup(client), 'octocat');
    expect([again.created, again.gist.id]).toEqual([false, first.gist.id]);
  });
});

describe('graphGistReadme', () => {
  it('shows the graph and links the project', () => {
    const readme = graphGistReadme('octocat', 'abc');
    expect(readme).toContain('https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-dark.svg');
    expect(readme).toContain('npx tokengraph');
  });
});
