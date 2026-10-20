import { realpathSync, statSync } from 'node:fs';
import { readConfig, readConfigSync, writeConfigSync, MAX_REMEMBERED_ROOTS, type CliConfig } from './config.js';
import { ROOT_SPECS } from './agent-root-specs.js';
import { environmentOverrides, pathFor, planScan, processRootContext, type RootContext, type RootOrigin, type RootSpec, type RootsOption } from './agent-roots.js';

/** Roots an earlier run recorded for one source; none when the config is unreadable. */
export async function rememberedRoots(source: string): Promise<string[]> {
  return (await readConfig()).agentRoots?.[source] ?? [];
}

/** The context and remembered roots an adapter uses: the caller's (tests, `status`) or this process's. */
export async function resolveAdapterRoots(spec: RootSpec, option?: RootsOption['roots']): Promise<{ ctx: RootContext; remembered: readonly string[] }> {
  return option ?? { ctx: processRootContext(), remembered: await rememberedRoots(spec.source) };
}

function targetExistsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sameRoot(ctx: RootContext, a: string, b: string): boolean {
  const fold = (value: string): string => (ctx.platform === 'win32' ? pathFor(ctx.platform).normalize(value).toLowerCase() : pathFor(ctx.platform).normalize(value));
  return fold(a) === fold(b) || realOrSelf(a) === realOrSelf(b);
}

/**
 * Writes the roots this run's environment points at (and that exist) into `config.json`'s `agentRoots`,
 * so a later run without that environment still reads them. Returns the roots newly added, per source.
 * Synchronous and quick (one small read, a write only when something is new) because the Claude Code
 * hook calls it under a deadline. Never throws: a config it cannot write only means the next
 * interactive run records the root instead.
 */
export function rememberAgentRoots(ctx: RootContext = processRootContext(), specs: readonly RootSpec[] = ROOT_SPECS): Record<string, string[]> {
  const added: Record<string, string[]> = {};
  try {
    const config: CliConfig = readConfigSync();
    const agentRoots: Record<string, string[]> = { ...(config.agentRoots ?? {}) };
    for (const spec of specs) {
      const known = agentRoots[spec.source] ?? [];
      const fresh: string[] = [];
      for (const root of environmentOverrides(spec, ctx)) {
        if (!spec.targets(root, ctx).some((target) => targetExistsSync(target.path))) continue;
        if ([...known, ...fresh].some((other) => sameRoot(ctx, other, root))) continue;
        if (known.length + fresh.length >= MAX_REMEMBERED_ROOTS) break;
        fresh.push(root);
      }
      if (fresh.length > 0) {
        agentRoots[spec.source] = [...known, ...fresh];
        added[spec.source] = fresh;
      }
    }
    if (Object.keys(added).length > 0) writeConfigSync({ ...config, agentRoots });
  } catch {
    // Best effort, see above.
  }
  return added;
}

/** Commands run by a person (or the schedule) in a shell whose environment may carry agent folder overrides. `hook-sync` does its own remembering. */
export const COMMANDS_THAT_REMEMBER_ROOTS: ReadonlySet<string> = new Set(['sync', 'view', 'status', 'schedule', 'install-hook']);

/** Remembers this process's agent folder overrides when `command` is one that should. */
export function rememberRootsForCommand(command: string, ctx: RootContext = processRootContext()): Record<string, string[]> {
  return COMMANDS_THAT_REMEMBER_ROOTS.has(command) ? rememberAgentRoots(ctx) : {};
}

/** What `status` shows for one adapter: every folder or file it scans for, and whether it exists. */
export interface AgentRootsReport {
  source: string;
  targets: { path: string; root: string; origin: RootOrigin; exists: boolean }[];
}

/** The scan plan of every adapter, existing and missing targets alike (a remembered root that is gone shows as missing). */
export async function agentRootsReport(
  remembered: Readonly<Record<string, readonly string[]>> = {},
  ctx: RootContext = processRootContext(),
  specs: readonly RootSpec[] = ROOT_SPECS,
): Promise<AgentRootsReport[]> {
  const report: AgentRootsReport[] = [];
  for (const spec of specs) {
    const planned = await planScan(spec, ctx, remembered[spec.source] ?? []);
    report.push({ source: spec.source, targets: planned.map(({ path, root, origin, exists }) => ({ path, root, origin, exists })) });
  }
  return report;
}
