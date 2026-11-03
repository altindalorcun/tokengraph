import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cliVersion } from './bin-path.js';
import { readConfig, type CliConfig } from './config.js';
import { updateCheckPath } from './paths.js';

const PACKAGE = 'tokengraph';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;
// Plain releases only. This one pattern guards everything a version reaches: the screen, and the install command.
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

export interface UpdateCheckDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  current?: () => string;
  config?: CliConfig;
  cachePath?: string;
  timeoutMs?: number;
}

/** True for a plain `x.y.z` release, the only kind of version that may reach the screen or an npm command. */
export function isReleaseVersion(version: string): boolean {
  return RELEASE.test(version);
}

/** True when `candidate` is a later plain release than `current`. Anything else (a prerelease, 'unknown') is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = RELEASE.exec(candidate);
  const installed = RELEASE.exec(current);
  if (!next || !installed) return false;
  for (const part of [1, 2, 3]) {
    const difference = Number(next[part]) - Number(installed[part]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** The daily check is off with `tokengraph update off`, either opt-out variable, or in CI. */
export function updateChecksEnabled(config: CliConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (config.update?.check === false) return false;
  return !env['TOKENGRAPH_NO_UPDATE_CHECK'] && !env['NO_UPDATE_NOTIFIER'] && !env['CI'];
}

function registryBase(env: NodeJS.ProcessEnv): string {
  return (env['TOKENGRAPH_NPM_REGISTRY'] ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
}

/** The version npm calls latest, or null for every kind of failure: being offline must never show as an error. */
export async function fetchLatestVersion(deps: UpdateCheckDeps = {}): Promise<string | null> {
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const response = await fetchImpl(`${registryBase(deps.env ?? process.env)}/${PACKAGE}/latest`, {
      headers: { accept: 'application/json', 'user-agent': `${PACKAGE}/${cliVersion()}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version?: unknown };
    return typeof version === 'string' && RELEASE.test(version) ? version : null;
  } catch {
    return null;
  }
}

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

async function readCache(path: string): Promise<UpdateCache | null> {
  try {
    const { checkedAt, latest } = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateCache>;
    return typeof checkedAt === 'number' && typeof latest === 'string' && RELEASE.test(latest) ? { checkedAt, latest } : null;
  } catch {
    return null;
  }
}

/** Best effort: without the file the next run simply asks again. */
async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // A read-only home directory must not fail the command that is running.
  }
}

/** Asks npm now and remembers the answer. A failed request leaves what was known. */
export async function checkLatestNow(deps: UpdateCheckDeps = {}): Promise<string | null> {
  const latest = await fetchLatestVersion(deps);
  if (latest !== null) await writeCache(deps.cachePath ?? updateCheckPath(), { checkedAt: (deps.now ?? Date.now)(), latest });
  return latest;
}

/** Asks npm at most once a day, and only when checks are on. Never throws. */
export async function refreshUpdateCheck(deps: UpdateCheckDeps = {}): Promise<void> {
  const config = deps.config ?? (await readConfig());
  if (!updateChecksEnabled(config, deps.env)) return;
  const now = (deps.now ?? Date.now)();
  const cache = await readCache(deps.cachePath ?? updateCheckPath());
  // A stored time in the future means the clock moved; it must not silence the check until that date.
  if (cache && cache.checkedAt <= now && now - cache.checkedAt < CHECK_INTERVAL_MS) return;
  await checkLatestNow(deps);
}

/** The newer version the last check found, or null. Reads the local file only, so it is safe in any offline command. */
export async function knownUpdate(deps: UpdateCheckDeps = {}): Promise<string | null> {
  const config = deps.config ?? (await readConfig());
  if (!updateChecksEnabled(config, deps.env)) return null;
  const cache = await readCache(deps.cachePath ?? updateCheckPath());
  return cache && isNewerVersion(cache.latest, (deps.current ?? cliVersion)()) ? cache.latest : null;
}

export function updateNotice(latest: string, current: string): string {
  return `tokengraph ${latest} is available (you have ${current}). Run \`tokengraph update\` to get it.`;
}
