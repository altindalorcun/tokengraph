import { GitHubNotFoundError, type Gist, type GitHubClient } from '../github/http.js';
import { PROJECT_URL, readmeSnippet } from '../readme-snippet.js';

export const GRAPH_MARKER = 'tokengraph-dark.svg';
export const DATA_MARKER = 'tokengraph-data.md';
export const GRAPH_DESCRIPTION = 'My AI coding token graph · made with tokengraph (npx tokengraph)';
export const DATA_DESCRIPTION = 'tokengraph data, written by the tokengraph CLI. Do not edit.';

export function graphGistReadme(login: string, gistId: string): string {
  return [
    '# My AI coding token graph',
    '',
    readmeSnippet(login, gistId),
    '',
    `Made with [tokengraph](${PROJECT_URL}): a GitHub-style graph of the tokens your AI coding agents burn each day.`,
    'Try it: `npx tokengraph`',
    '',
  ].join('\n');
}

export function dataGistReadme(): string {
  return [
    '# tokengraph data',
    '',
    `This secret gist is written by the [tokengraph](${PROJECT_URL}) CLI. Each \`machine-<id>.json\` file holds one`,
    "machine's daily token counts per agent and model, so your machines add up to one graph and a reinstall",
    'gets its history back. It holds token counts only: no prompts, no code, no file names.',
    '',
    'Secret gists are unlisted, not private: anyone with this URL can read it. Do not edit the files by hand.',
    '',
  ].join('\n');
}

export interface GistLookup {
  list(): Promise<Gist[]>;
}

/** Listing every gist is the expensive call, so one publish does it at most once. */
export function gistLookup(client: GitHubClient): GistLookup {
  let listed: Promise<Gist[]> | null = null;
  return { list: () => (listed ??= client.listGists()) };
}

async function getIfExists(client: GitHubClient, id: string | undefined): Promise<Gist | null> {
  if (!id) return null;
  try {
    return await client.getGist(id);
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return null;
    throw error;
  }
}

async function findByMarker(client: GitHubClient, lookup: GistLookup, marker: string): Promise<Gist | null> {
  const found = (await lookup.list()).find((gist) => marker in gist.files);
  return found ? getIfExists(client, found.id) : null;
}

export async function ensureDataGist(client: GitHubClient, cachedId: string | undefined, lookup: GistLookup): Promise<{ gist: Gist; created: boolean }> {
  const existing = (await getIfExists(client, cachedId)) ?? (await findByMarker(client, lookup, DATA_MARKER));
  if (existing) return { gist: existing, created: false };
  const gist = await client.createGist({ description: DATA_DESCRIPTION, public: false, files: { [DATA_MARKER]: dataGistReadme() } });
  return { gist, created: true };
}

export async function ensureGraphGist(
  client: GitHubClient,
  cachedId: string | undefined,
  lookup: GistLookup,
  initialFiles: Record<string, string>,
): Promise<{ gist: Gist; created: boolean; replacedCached: boolean }> {
  const cached = await getIfExists(client, cachedId);
  if (cached) return { gist: cached, created: false, replacedCached: false };
  const found = await findByMarker(client, lookup, GRAPH_MARKER);
  if (found) return { gist: found, created: false, replacedCached: cachedId !== undefined && found.id !== cachedId };
  const gist = await client.createGist({ description: GRAPH_DESCRIPTION, public: true, files: initialFiles });
  return { gist, created: true, replacedCached: cachedId !== undefined };
}
