import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { dateKey, formatTokens } from '@tokengraph/core';
import { readConfig, writeConfig, type CliConfig } from '../config.js';
import { readLedger, type Ledger } from '../ledger.js';
import { ledgerPath } from '../paths.js';
import { planProjectEdit, settleNames, type ProjectEdit, type ProjectEditResult } from '../project-names.js';
import { normaliseFolder, resolveProjectRoot } from '../project-roots.js';
import { cleanProjectName, NOT_ASSIGNED, projectDisplayNames, projectRows, stripControl, summariseProjects, type ProjectShare, type ProjectSummary } from '../project-usage.js';
import { shortDate } from '../tui/dates.js';
import { formatCost, RANGE_LABELS, RANGES, type RangeKey } from '../tui/model.js';

export type ProjectsCommand =
  | { action: 'list'; range: RangeKey; json: boolean }
  | { action: 'show'; name: string; range: RangeKey; json: boolean }
  | { action: 'name'; target: string; name: string | null }
  | { action: 'merge'; project: string; into: string }
  | { action: 'split'; project: string };

export interface ProjectsDeps {
  ledger: () => Promise<Ledger>;
  config: () => Promise<CliConfig>;
  saveConfig: (config: CliConfig) => Promise<void>;
  today: () => string;
  home: () => string;
  cwd: () => string;
}

const DEFAULT_DEPS: ProjectsDeps = {
  ledger: () => readLedger(ledgerPath()),
  config: () => readConfig(),
  saveConfig: (config) => writeConfig(config),
  today: () => dateKey(new Date()),
  home: () => homedir(),
  cwd: () => process.cwd(),
};

const USAGE = 'Usage: tokengraph projects [--range <range>] [--json]\n       tokengraph projects show <name> [--range <range>] [--json]\n       tokengraph projects name <name-or-folder> <new-name>\n       tokengraph projects name <name-or-folder> --reset\n       tokengraph projects merge <project> <into-project>\n       tokengraph projects split <project>';
const ESTIMATE_NOTE = 'This machine only. Cost is an estimate at public list prices, not what a subscription plan charges.';

/** Validates the flags and positionals; returns the command, or the error message to print. */
export function parseProjectsArgs(values: Record<string, string | boolean | undefined>, positionals: readonly string[]): ProjectsCommand | string {
  const rawRange = values['range'] ?? '30d';
  if (!RANGES.includes(rawRange as RangeKey)) return `--range must be one of ${RANGES.join(', ')}.`;
  const range = rawRange as RangeKey;
  const json = values['json'] === true;
  const [action, ...rest] = positionals;
  if (action === undefined) return { action: 'list', range, json };
  if (action === 'show' && rest.length === 1) return { action: 'show', name: rest[0]!, range, json };
  if (action === 'name') {
    if (values['reset'] === true && rest.length === 1) return { action: 'name', target: rest[0]!, name: null };
    if (values['reset'] !== true && rest.length === 2) return { action: 'name', target: rest[0]!, name: rest[1]! };
  }
  if (values['reset'] !== true && action === 'merge' && rest.length === 2) return { action: 'merge', project: rest[0]!, into: rest[1]! };
  if (values['reset'] !== true && action === 'split' && rest.length === 1) return { action: 'split', project: rest[0]! };
  return USAGE;
}

async function summaries(deps: ProjectsDeps, range: RangeKey): Promise<ProjectSummary[]> {
  const [ledger, config] = await Promise.all([deps.ledger(), deps.config()]);
  return summariseProjects(projectRows(ledger, config.projects?.names ?? {}, deps.home()), range, deps.today());
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => [...row[column]!].length)));
  return rows.map((row) => `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ')}`.trimEnd());
}

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** JSON for a terminal. `JSON.stringify` escapes C0 control characters but leaves C1 ones, which some terminals obey. */
function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function shareJson(share: ProjectShare) {
  return { key: share.key, name: share.name, weightedTokens: share.weighted, share: share.share, estimatedCostUsd: share.cost.pricedWeighted > 0 ? share.cost.dollars : null, unpricedWeightedTokens: share.cost.unpricedWeighted };
}

function projectJson(project: ProjectSummary) {
  return {
    name: project.name,
    assigned: project.assigned,
    weightedTokens: project.weighted,
    share: project.share,
    estimatedCostUsd: project.cost.pricedWeighted > 0 ? project.cost.dollars : null,
    unpricedWeightedTokens: project.cost.unpricedWeighted,
    lastActive: project.lastActive,
    models: project.models.map(shareJson),
    agents: project.agents.map(shareJson),
  };
}

export async function runProjects(options: { range: RangeKey; json: boolean }, overrides: Partial<ProjectsDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const projects = await summaries(deps, options.range);
  if (options.json) {
    console.log(terminalJson({ schema: 1, scope: 'this-machine', range: options.range, projects: projects.map(projectJson) }));
    return 0;
  }
  if (projects.length === 0) {
    console.log(
      options.range === 'all'
        ? 'No usage yet. Run `tokengraph sync --local` to read your agents.'
        : `No usage in the last ${RANGE_LABELS[options.range].toLowerCase()}. Try --range all, or run \`tokengraph sync --local\`.`,
    );
    return 0;
  }
  console.log(`Projects, ${RANGE_LABELS[options.range].toLowerCase()}\n`);
  console.log(table([['PROJECT', 'TOKENS', 'SHARE', 'COST', 'LAST ACTIVE'], ...projects.map((p) => [p.name, formatTokens(p.weighted), percent(p.share), formatCost(p.cost), shortDate(p.lastActive)])]).join('\n'));
  console.log(`\n${ESTIMATE_NOTE}`);
  if (projects.some((p) => !p.assigned)) console.log(`${NOT_ASSIGNED}: usage with no known project, such as older logs that are gone and Cursor's account history.`);
  return 0;
}

export async function runProjectsShow(name: string, options: { range: RangeKey; json: boolean }, overrides: Partial<ProjectsDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const projects = await summaries(deps, options.range);
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) {
    const period = options.range === 'all' ? '' : ` in the last ${RANGE_LABELS[options.range].toLowerCase()}`;
    console.error(`No project named "${cleanProjectName(name)}"${period}. Projects: ${projects.map((p) => p.name).join(', ') || 'none'}.`);
    return 1;
  }
  if (options.json) {
    console.log(terminalJson({ schema: 1, scope: 'this-machine', range: options.range, ...projectJson(project), folders: project.folders }));
    return 0;
  }
  const shares = (title: string, rows: readonly ProjectShare[]): string =>
    table([[title, 'TOKENS', 'SHARE', 'COST'], ...rows.map((row) => [stripControl(row.name), formatTokens(row.weighted), percent(row.share), formatCost(row.cost)])]).join('\n');
  console.log(`${project.name}, ${RANGE_LABELS[options.range].toLowerCase()}: ${formatTokens(project.weighted)} tokens, ${formatCost(project.cost)}\n`);
  console.log(`${shares('MODEL', project.models)}\n\n${shares('AGENT', project.agents)}`);
  if (project.folders.length > 0) console.log(`\nFolders:\n${project.folders.map((folder) => `  ${stripControl(folder)}`).join('\n')}`);
  console.log(`\n${ESTIMATE_NOTE}`);
  return 0;
}

const looksLikePath = (target: string): boolean => target === '.' || target === '..' || (/[\\/]/.test(target) && (target.startsWith('.') || /^([a-z]:)?[\\/]/i.test(target)));

/** The roots a target means: a folder of a known project, a project's name, or the last part of a folder's path. */
async function matchRoots(target: string, roots: readonly string[], display: ReadonlyMap<string, string>, storedRoots: Readonly<Record<string, string>>, cwd: string, home: string): Promise<string[]> {
  if (looksLikePath(target)) {
    const folder = normaliseFolder(resolve(cwd, target));
    const root = await resolveProjectRoot(folder, { home });
    const direct = [storedRoots[folder], root, folder].find((candidate) => candidate !== undefined && roots.includes(candidate));
    if (direct !== undefined) return [direct];
    // A subfolder no session ran in still belongs to the project above it, unless that is only the home folder.
    return roots.filter((candidate) => candidate !== normaliseFolder(home) && root.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length).slice(0, 1);
  }
  const exact = roots.filter((root) => display.get(root) === target);
  return exact.length > 0 ? exact : roots.filter((root) => root.split('/').at(-1) === target);
}

/** Sets or, with `name` null, removes the name of a project. Names live in config.json, so this never touches a count. */
export async function runProjectsName(target: string, name: string | null, overrides: Partial<ProjectsDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const [ledger, config] = await Promise.all([deps.ledger(), deps.config()]);
  const storedRoots = ledger.projects?.roots ?? {};
  const names = config.projects?.names ?? {};
  const roots = [...new Set(projectRows(ledger, names, deps.home()).flatMap((row) => (row.folder === null ? [] : [row.folder])))];
  const display = projectDisplayNames(roots, names, deps.home());

  const newName = name === null ? null : cleanProjectName(name);
  if (newName === '') {
    console.error('A project name needs at least one visible character.');
    return 1;
  }
  if (newName?.toLowerCase() === NOT_ASSIGNED.toLowerCase() || target === NOT_ASSIGNED) {
    console.error(`"${NOT_ASSIGNED}" is the row for usage with no known project; it cannot be a project's name or be renamed.`);
    return 1;
  }
  const matches = await matchRoots(target, roots, display, storedRoots, deps.cwd(), deps.home());
  if (matches.length === 0) {
    console.error(`No recorded usage for "${cleanProjectName(target)}". Run \`tokengraph projects --range all\` to see the names.`);
    return 1;
  }
  const shown = new Set(matches.map((root) => display.get(root)));
  if (shown.size > 1) {
    console.error(`"${cleanProjectName(target)}" fits several projects. Use one of: ${[...shown].join(', ')}.`);
    return 1;
  }
  // A name another project shows merges with it for good, and no other project changes its name.
  const next = settleNames(names, ledger, deps.home(), new Map(matches.map((root) => [root, newName])));
  await deps.saveConfig({ ...config, projects: { names: next } });
  console.log(newName === null ? `Removed the name of "${cleanProjectName(target)}".` : `Named it "${newName}". Folders with the same name count as one project.`);
  return 0;
}

/**
 * Merges, renames or splits projects by their exact names, as the view shows them. The config is read right before it
 * is written, so a name set elsewhere in the meantime is kept. Nothing is written when the edit is refused.
 */
export async function editProjects(edit: ProjectEdit, overrides: Partial<ProjectsDeps> = {}): Promise<ProjectEditResult> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const [ledger, config] = await Promise.all([deps.ledger(), deps.config()]);
  const names = config.projects?.names ?? {};
  const result = planProjectEdit(edit, names, ledger, deps.home());
  if (result.ok) await deps.saveConfig({ ...config, projects: { names: result.names } });
  return result;
}

/**
 * The project a target means, like `projects name` reads it: an exact name, a folder, or the last part of a folder's
 * path. `exact` drops the last of these, for an edit that must not reach past the folder that was meant.
 */
async function resolveProject(target: string, deps: ProjectsDeps, exact = false): Promise<{ name: string } | { error: string }> {
  const [ledger, config] = await Promise.all([deps.ledger(), deps.config()]);
  const names = config.projects?.names ?? {};
  const rows = projectRows(ledger, names, deps.home());
  if (target === NOT_ASSIGNED) return { error: `"${NOT_ASSIGNED}" is the row for usage with no known project; it cannot be merged or split.` };
  if (rows.some((row) => row.project === target && row.folder !== null)) return { name: target };
  if (exact && !looksLikePath(target)) {
    return { error: `No project named "${cleanProjectName(target)}". Give a project's exact name (see \`tokengraph projects --range all\`) or a folder path.` };
  }
  const roots = [...new Set(rows.flatMap((row) => (row.folder === null ? [] : [row.folder])))];
  const display = projectDisplayNames(roots, names, deps.home());
  const matches = await matchRoots(target, roots, display, ledger.projects?.roots ?? {}, deps.cwd(), deps.home());
  const shown = [...new Set(matches.map((root) => display.get(root)!))];
  if (shown.length === 0) return { error: `No recorded usage for "${cleanProjectName(target)}". Run \`tokengraph projects --range all\` to see the names.` };
  if (shown.length > 1) return { error: `"${cleanProjectName(target)}" fits several projects. Use one of: ${shown.join(', ')}.` };
  return { name: shown[0]! };
}

function refuse(error: string): number {
  console.error(error);
  return 1;
}

async function runEdit(edit: ProjectEdit, deps: ProjectsDeps): Promise<number> {
  const result = await editProjects(edit, deps);
  if (!result.ok) return refuse(result.error);
  console.log(result.message);
  return 0;
}

/** `projects merge a b`: every folder of both projects gets b's name, so they count as one project called b. */
export async function runProjectsMerge(project: string, into: string, overrides: Partial<ProjectsDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const from = await resolveProject(project, deps);
  if ('error' in from) return refuse(from.error);
  const to = await resolveProject(into, deps);
  if ('error' in to) return refuse(to.error);
  return runEdit({ projects: 'merge', project: from.name, into: to.name }, deps);
}

/**
 * `projects split p`: removes the names of p's folders, so each counts as its own project again. It takes an exact name
 * or a path only: a folder's last part alone would split the whole project that folder is in.
 */
export async function runProjectsSplit(project: string, overrides: Partial<ProjectsDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const target = await resolveProject(project, deps, true);
  if ('error' in target) return refuse(target.error);
  return runEdit({ projects: 'split', project: target.name }, deps);
}
