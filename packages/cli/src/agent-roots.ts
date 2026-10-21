import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32, type PlatformPath } from 'node:path';

/**
 * Where an agent keeps its files can depend on the platform, the home folder and environment
 * variables only the agent's own process (or the user's shell) has: a profile named by
 * `CLAUDE_CONFIG_DIR` in a VS Code setting, `XDG_DATA_HOME` in a dotfiles setup. An hourly schedule
 * gets none of that. So every adapter scans the union of
 *
 *   - its default roots (from the home folder and the platform),
 *   - the roots named by the environment of the current run, and
 *   - the roots remembered in `config.json` (`agentRoots`), recorded whenever a command ran with
 *     an override in its environment,
 *
 * deduplicated by real path. This module is the pure half: it computes root candidates from an
 * injected `{ platform, env, home }` (no `process.env`, `os.homedir` or `process.platform` inside a
 * resolver), so the win32, linux and darwin branches can be tested on any machine. The only file
 * system access is `planScan`, which checks which targets exist.
 */

export interface RootContext {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

/** The real platform, environment and home folder of this process. */
export function processRootContext(): RootContext {
  return { platform: process.platform, env: process.env, home: homedir() };
}

export type RootOrigin = 'default' | 'env' | 'remembered';

/** One file or folder an adapter reads, reached through a root. `kind` tells the adapter how to read it. */
export interface RootTarget {
  path: string;
  kind: string;
}

/**
 * How one agent's roots are found. A root is a string: usually the folder the agent keeps its data
 * in; an adapter may prefix a different kind of root (`desktop:`, `sessions:`, ...) with `kindedRoot`.
 */
export interface RootSpec {
  /** The ledger source this spec belongs to. */
  source: string;
  /** Roots that need no environment variable. */
  defaults(ctx: RootContext): string[];
  /** Roots the environment of this run points at. Only the ones that differ from `defaults` are remembered. */
  fromEnv(ctx: RootContext): string[];
  /** The files and folders one root is read through. */
  targets(root: string, ctx: RootContext): RootTarget[];
}

export interface RootCandidate {
  root: string;
  origin: RootOrigin;
}

export interface PlannedTarget extends RootTarget {
  root: string;
  origin: RootOrigin;
  exists: boolean;
}

export function pathFor(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix;
}

/** A non-empty trimmed environment value, or undefined: an empty variable counts as unset (as Codex treats `CODEX_HOME=""`). */
export function envText(ctx: RootContext, name: string): string | undefined {
  const value = ctx.env[name]?.trim();
  return value ? value : undefined;
}

/** A leading `~`, `~/` (and, on Windows, `~\`) becomes the home folder. */
export function expandHome(ctx: RootContext, value: string): string {
  const path = pathFor(ctx.platform);
  if (value === '~') return ctx.home;
  if (value.startsWith('~/') || (ctx.platform === 'win32' && value.startsWith('~\\'))) return path.join(ctx.home, value.slice(2));
  return value;
}

/** Git Bash, MSYS and Cygwin style `/c/Users/me` to `C:\Users\me`; only meaningful on Windows. */
export function windowsShellPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return value;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
  if (!match) return value;
  return `${match[1]!.toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}`;
}

function fileUrlPath(ctx: RootContext, value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost')) return undefined;
    const decoded = decodeURIComponent(url.pathname);
    if (ctx.platform !== 'win32') return decoded;
    return (/^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded).replaceAll('/', '\\');
  } catch {
    return undefined;
  }
}

export interface PathValueOptions {
  /** Accept `file://` URLs (pi does). */
  fileUrl?: boolean;
  /** Convert Git Bash style drive paths on Windows (pi does). */
  shellPaths?: boolean;
}

/**
 * A folder named by an environment-style value: trimmed, `~` expanded, normalised and without a
 * trailing separator. A relative value is `undefined`: no agent resolves one against the home
 * folder, and resolving it against this process's working directory would name a different place
 * than the agent meant (and a different one again under cron or launchd).
 */
export function absolutePath(ctx: RootContext, raw: string | undefined, options: PathValueOptions = {}): string | undefined {
  let value = raw?.trim();
  if (!value) return undefined;
  const path = pathFor(ctx.platform);
  if (options.shellPaths && ctx.platform === 'win32') value = windowsShellPath(value);
  value = expandHome(ctx, value);
  if (options.fileUrl && /^file:\/\//i.test(value)) {
    const converted = fileUrlPath(ctx, value);
    if (converted === undefined) return undefined;
    value = converted;
  }
  if (!path.isAbsolute(value)) return undefined;
  let normal = path.normalize(value);
  const root = path.parse(normal).root;
  while (normal.length > root.length && (normal.endsWith(path.sep) || normal.endsWith('/'))) normal = normal.slice(0, -1);
  return normal;
}

/** `absolutePath` of an environment variable. */
export function envPath(ctx: RootContext, name: string, options: PathValueOptions = {}): string | undefined {
  return absolutePath(ctx, ctx.env[name], options);
}

/** A root that is not a plain folder: `desktop:/path`, `sessions:/path`. A Windows drive letter never looks like one. */
export function kindedRoot(kind: string, path: string): string {
  return `${kind}:${path}`;
}

export function parseKindedRoot(root: string): { kind: string; path: string } {
  const match = /^([a-z][a-z-]+):(.*)$/.exec(root);
  return match ? { kind: match[1]!, path: match[2]! } : { kind: '', path: root };
}

function sameLexically(platform: NodeJS.Platform, a: string, b: string): boolean {
  const path = pathFor(platform);
  const fold = (value: string): string => (platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value));
  return fold(a) === fold(b);
}

/** Default roots, then the environment's, then the remembered ones; a root seen twice keeps its first origin. */
export function candidateRoots(spec: RootSpec, ctx: RootContext, remembered: readonly string[] = []): RootCandidate[] {
  const all: RootCandidate[] = [
    ...spec.defaults(ctx).map((root) => ({ root, origin: 'default' as const })),
    ...spec.fromEnv(ctx).map((root) => ({ root, origin: 'env' as const })),
    ...remembered.filter((root) => root.trim() !== '').map((root) => ({ root, origin: 'remembered' as const })),
  ];
  const unique: RootCandidate[] = [];
  for (const candidate of all) {
    if (!unique.some((seen) => sameLexically(ctx.platform, seen.root, candidate.root))) unique.push(candidate);
  }
  return unique;
}

/** The environment's roots that are not simply a default: what a later run without that environment needs to be told. */
export function environmentOverrides(spec: RootSpec, ctx: RootContext): string[] {
  const defaults = spec.defaults(ctx);
  return spec.fromEnv(ctx).filter((root, index, all) => {
    const duplicate = all.findIndex((other) => sameLexically(ctx.platform, other, root)) !== index;
    return !duplicate && !defaults.some((known) => sameLexically(ctx.platform, known, root));
  });
}

/** The lexical targets of every candidate root, before any file system check. */
export function plannedPaths(spec: RootSpec, ctx: RootContext, remembered: readonly string[] = []): { root: string; origin: RootOrigin; target: RootTarget }[] {
  return candidateRoots(spec, ctx, remembered).flatMap(({ root, origin }) => spec.targets(root, ctx).map((target) => ({ root, origin, target })));
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Every target of every root, with whether it exists. Targets that reach the same real path through
 * different spellings (a symlinked profile, `~/.claude` named by `CLAUDE_CONFIG_DIR` too, a trailing
 * slash, another letter case) are listed once, under the first origin that named them.
 */
export async function planScan(spec: RootSpec, ctx: RootContext, remembered: readonly string[] = []): Promise<PlannedTarget[]> {
  const planned: PlannedTarget[] = [];
  const seenReal = new Set<string>();
  const seenLexical: { path: string; kind: string }[] = [];
  for (const { root, origin, target } of plannedPaths(spec, ctx, remembered)) {
    const real = await realPathOrNull(target.path);
    if (real !== null) {
      const key = `${target.kind}\0${real}`;
      if (seenReal.has(key)) continue;
      seenReal.add(key);
      planned.push({ ...target, root, origin, exists: true });
      continue;
    }
    if (seenLexical.some((seen) => seen.kind === target.kind && sameLexically(ctx.platform, seen.path, target.path))) continue;
    seenLexical.push(target);
    planned.push({ ...target, root, origin, exists: false });
  }
  return planned;
}

/** The existing targets, optionally of one kind. */
export async function existingTargets(
  spec: RootSpec,
  ctx: RootContext,
  remembered: readonly string[],
  kind?: string,
): Promise<PlannedTarget[]> {
  return (await planScan(spec, ctx, remembered)).filter((target) => target.exists && (kind === undefined || target.kind === kind));
}

/**
 * Lets a loop over several roots skip a file it already read through another root (a root nested in
 * another, two spellings of one profile that `planScan` could not see). Compares real paths.
 */
export class FileDeduper {
  private readonly seen = new Set<string>();

  /** True the first time a file is offered, false for the same file again. */
  async first(path: string): Promise<boolean> {
    const real = (await realPathOrNull(path)) ?? path;
    if (this.seen.has(real)) return false;
    this.seen.add(real);
    return true;
  }
}

export async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFilePath(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Where a root can be read from, so a test or a caller can supply its own context and remembered roots. */
export interface RootsOption {
  roots?: { ctx: RootContext; remembered: readonly string[] };
}
