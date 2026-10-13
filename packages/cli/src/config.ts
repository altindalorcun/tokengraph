import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configPath } from './paths.js';

export const DEFAULT_API_URL = 'http://localhost:3000';

export interface CliConfig {
  apiUrl?: string;
  apiKey?: string;
  deviceId?: string;
  username?: string;
  /** false = never upload from this machine. Absent means true. */
  uploads?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps only well-formed fields, so a hand-edited or damaged file degrades to "logged out". */
export function parseConfig(raw: unknown): CliConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const fields = raw as Record<string, unknown>;
  const text = (key: string) => (typeof fields[key] === 'string' && fields[key] !== '' ? fields[key] : undefined);

  const config: CliConfig = {};
  const apiUrl = text('apiUrl');
  if (apiUrl && /^https?:\/\//.test(apiUrl)) config.apiUrl = apiUrl;
  const apiKey = text('apiKey');
  if (apiKey?.startsWith('tg_')) config.apiKey = apiKey;
  const deviceId = text('deviceId');
  if (deviceId && UUID.test(deviceId)) config.deviceId = deviceId;
  const username = text('username');
  if (username) config.username = username;
  if (typeof fields['uploads'] === 'boolean') config.uploads = fields['uploads'];
  return config;
}

export function resolveApiUrl(config: CliConfig, override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return (override ?? env['TOKENGRAPH_API_URL'] ?? config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
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
  const temporary = `${path}.tmp`;
  // The file holds an API key, so only its owner may read it.
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
