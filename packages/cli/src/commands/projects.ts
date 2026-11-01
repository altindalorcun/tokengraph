import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { dateKey, formatTokens } from '@tokengraph/core';
import { readConfig, writeConfig, type CliConfig } from '../config.js';
import { readLedger, type Ledger } from '../ledger.js';
import { ledgerPath } from '../paths.js';
import { normaliseFolder, resolveProjectRoot } from '../project-roots.js';
import { cleanProjectName, NOT_ASSIGNED, projectDisplayNames, projectRows, stripControl, summariseProjects, type ProjectShare, type ProjectSummary } from '../project-usage.js';
import { shortDate } from '../tui/dates.js';
import { formatCost, RANGE_LABELS, RANGES, type RangeKey } from '../tui/model.js';

export type ProjectsCommand =
  | { action: 'list'; range: RangeKey; json: boolean }
  | { action: 'show'; name: string; range: RangeKey; json: boolean }
  | { action: 'name'; target: string; name: string | null };

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

const USAGE = 'Usage: tokengraph projects [--range <range>] [--json]\n       tokengraph projects show <name> [--range <range>] [--json]\n       tokengraph projects name <name-or-folder> <new-name>\n       tokengraph projects name <name-or-folder> --reset';
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
  const next = { ...names };
  for (const root of matches) {
    if (newName === null) delete next[root];
    else next[root] = newName;
  }
  await deps.saveConfig({ ...config, projects: { names: next } });
  console.log(newName === null ? `Removed the name of "${cleanProjectName(target)}".` : `Named it "${newName}". Folders with the same name count as one project.`);
  return 0;
}
