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

/** A gist someone else owns can be read but never written: for this login it does not exist. */
function ownedBy(gist: Gist, login: string | undefined): boolean {
  return !gist.owner || login === undefined || gist.owner.login.toLowerCase() === login.toLowerCase();
}

async function getIfExists(client: GitHubClient, id: string | undefined, login: string | undefined): Promise<Gist | null> {
  if (!id) return null;
  try {
    const gist = await client.getGist(id);
    return ownedBy(gist, login) ? gist : null;
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return null;
    throw error;
  }
}

async function findByMarker(client: GitHubClient, lookup: GistLookup, marker: string, login: string | undefined): Promise<Gist | null> {
  // Several gists can carry the marker (a second machine raced the first one): the oldest is the original.
  const [found] = (await lookup.list())
    .filter((gist) => marker in gist.files)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id));
  return found ? getIfExists(client, found.id, login) : null;
}

export async function ensureDataGist(
  client: GitHubClient,
  cachedId: string | undefined,
  lookup: GistLookup,
  login?: string,
): Promise<{ gist: Gist; created: boolean }> {
  const existing = (await getIfExists(client, cachedId, login)) ?? (await findByMarker(client, lookup, DATA_MARKER, login));
  if (existing) return { gist: existing, created: false };
  const gist = await client.createGist({ description: DATA_DESCRIPTION, public: false, files: { [DATA_MARKER]: dataGistReadme() } });
  return { gist, created: true };
}

export async function ensureGraphGist(
  client: GitHubClient,
  cachedId: string | undefined,
  lookup: GistLookup,
  initialFiles: Record<string, string>,
  login?: string,
): Promise<{ gist: Gist; created: boolean; replacedCached: boolean }> {
  const cached = await getIfExists(client, cachedId, login);
  if (cached) return { gist: cached, created: false, replacedCached: false };
  const found = await findByMarker(client, lookup, GRAPH_MARKER, login);
  if (found) return { gist: found, created: false, replacedCached: cachedId !== undefined && found.id !== cachedId };
  const gist = await client.createGist({ description: GRAPH_DESCRIPTION, public: true, files: initialFiles });
  return { gist, created: true, replacedCached: cachedId !== undefined };
}
