import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isKnownSource } from '@tokengraph/core';
import { configPath } from './paths.js';

export type GitHubAuth = { kind: 'token'; token: string } | { kind: 'gh'; ghPath: string };

export interface GitHubAccount {
  login: string;
  auth: GitHubAuth;
}

export type GraphColors = 'model' | 'single';

export interface CliConfig {
  /** This machine's id in the data gist. Kept on logout: a machine must never come back under a new id. */
  machineId?: string;
  github?: GitHubAccount;
  /** Cached gist ids; found again by marker file when missing or deleted. */
  gists?: { graph?: string; data?: string };
  graph?: { colors?: GraphColors };
  /**
   * Agent folders remembered from the environment of an earlier run, per source, so a later run without
   * that environment (the hourly schedule) still scans them. Additive: older versions ignore the key.
   */
  agentRoots?: Record<string, string[]>;
  /**
   * `fetch`: whether sync reads the Cursor history from cursor.com with Cursor's own sign-in. Unset means
   * "on, once a manual sync has announced it"; `tokengraph cursor off` stores false. Never holds a credential.
   */
  cursor?: { fetch?: boolean };
}

/** The most roots remembered for one source; a config file is not a log. */
export const MAX_REMEMBERED_ROOTS = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIST_ID = /^[0-9a-f]{20,40}$/i;
// GitHub logins: alphanumerics and single hyphens, no leading or trailing hyphen, at most 39 chars.
// Enterprise Managed Users also carry an underscore (name_corp).
const LOGIN = /^[a-z0-9](?:[a-z0-9_]|-(?=[a-z0-9])){0,38}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseAuth(raw: unknown): GitHubAuth | undefined {
  const fields = record(raw);
  if (!fields) return undefined;
  if (fields['kind'] === 'token') {
    const token = text(fields['token']);
    return token ? { kind: 'token', token } : undefined;
  }
  if (fields['kind'] === 'gh') {
    const ghPath = text(fields['ghPath']);
    return ghPath ? { kind: 'gh', ghPath } : undefined;
  }
  return undefined;
}

/**
 * Keeps only well-formed fields, so a hand-edited or damaged file degrades to "logged out". Fields
 * from the hosted era (apiUrl, apiKey, username, uploads) are dropped; its deviceId becomes the
 * machine id, so the machine keeps its identity.
 */
export function parseConfig(raw: unknown): CliConfig {
  const fields = record(raw);
  if (!fields) return {};
  const config: CliConfig = {};

  const machineId = [text(fields['machineId']), text(fields['deviceId'])].find((id) => id !== undefined && UUID.test(id));
  if (machineId) config.machineId = machineId.toLowerCase();

  const github = record(fields['github']);
  if (github) {
    const login = text(github['login']);
    const auth = parseAuth(github['auth']);
    if (login && LOGIN.test(login) && auth) config.github = { login, auth };
  }

  const gists = record(fields['gists']);
  if (gists) {
    const graph = text(gists['graph']);
    const data = text(gists['data']);
    const parsed: NonNullable<CliConfig['gists']> = {};
    if (graph && GIST_ID.test(graph)) parsed.graph = graph;
    if (data && GIST_ID.test(data)) parsed.data = data;
    if (parsed.graph || parsed.data) config.gists = parsed;
  }

  const graph = record(fields['graph']);
  const colors = graph?.['colors'];
  if (colors === 'model' || colors === 'single') config.graph = { colors };

  const agentRoots = record(fields['agentRoots']);
  if (agentRoots) {
    const parsed: Record<string, string[]> = {};
    for (const [source, value] of Object.entries(agentRoots)) {
      if (!isKnownSource(source) || !Array.isArray(value)) continue;
      const roots = [...new Set(value.filter((root): root is string => typeof root === 'string' && root.trim() !== ''))].slice(0, MAX_REMEMBERED_ROOTS);
      if (roots.length > 0) parsed[source] = roots;
    }
    if (Object.keys(parsed).length > 0) config.agentRoots = parsed;
  }

  const cursor = record(fields['cursor']);
  if (cursor && typeof cursor['fetch'] === 'boolean') config.cursor = { fetch: cursor['fetch'] };

  return config;
}

export async function readConfig(path = configPath()): Promise<CliConfig> {
  try {
    return parseConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return {};
  }
}

export async function writeConfig(config: CliConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  // The file can hold a GitHub token, so only its owner may read it.
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

/** `readConfig` for callers that must not wait (the hook runs under a short deadline). */
export function readConfigSync(path = configPath()): CliConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

/** `writeConfig`, same guarantees: a temporary file renamed over the target, mode 0600. */
export function writeConfigSync(config: CliConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}
