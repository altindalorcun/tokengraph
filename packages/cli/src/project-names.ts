import { weightedTokens } from '@tokengraph/core';
import { normaliseFolder } from './project-roots.js';
import type { Ledger } from './ledger.js';
import { cleanProjectName, ledgerProjectRoots, NOT_ASSIGNED, projectDisplayNames, projectRows, type ProjectRow } from './project-usage.js';

/**
 * Merging, splitting and renaming projects. A project is every root that ends up with one display name, and the user's
 * names (config `projects.names`, root → name) are the only thing these change, so no count is ever touched. Shared by
 * `tokengraph projects` and the view's Projects tab; everything here is pure.
 */

/** One assigned project over all time, whatever range a view shows. */
export interface ProjectEntry {
  name: string;
  /** Its roots with recorded usage, biggest first. */
  roots: string[];
  weighted: number;
}

/** What `rename`, `merge` and `split` ask for. `merge` gives every root of `project` and `into` the name of `into`. */
export type ProjectEdit =
  | { projects: 'merge'; project: string; into: string }
  | { projects: 'rename'; project: string; name: string }
  | { projects: 'split'; project: string };

export type ProjectEditResult =
  | {
      ok: true;
      /** The whole new `projects.names` map. */
      names: Record<string, string>;
      /** One line for a terminal or a toast. */
      message: string;
      /** The project the edit leaves behind, for a view to keep selected. */
      select: string;
    }
  | { ok: false; error: string };

/** Every assigned project of the rows, biggest first. */
export function projectCatalogue(rows: readonly ProjectRow[]): ProjectEntry[] {
  const projects = new Map<string, { roots: Map<string, number>; weighted: number }>();
  for (const row of rows) {
    if (row.folder === null || row.project === NOT_ASSIGNED) continue;
    const entry = projects.get(row.project) ?? { roots: new Map<string, number>(), weighted: 0 };
    const weighted = weightedTokens(row.counts);
    entry.roots.set(row.folder, (entry.roots.get(row.folder) ?? 0) + weighted);
    entry.weighted += weighted;
    projects.set(row.project, entry);
  }
  return [...projects]
    .map(([name, { roots, weighted }]) => ({ name, roots: [...roots].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([root]) => root), weighted }))
    .sort((a, b) => b.weighted - a.weighted || a.name.localeCompare(b.name));
}

/** The roots of one project over all time; empty for Not assigned or a name nothing has. */
export function projectRoots(rows: readonly ProjectRow[], project: string): string[] {
  return projectCatalogue(rows).find((entry) => entry.name === project)?.roots ?? [];
}

const fail = (error: string): ProjectEditResult => ({ ok: false, error });
const quoted = (name: string): string => `"${name}"`;
const NOT_ASSIGNED_ERROR = `"${NOT_ASSIGNED}" is the row for usage with no known project; it cannot be merged, renamed or split.`;

/** A project's roots plus any root the config names alike that has no usage left, so a name never lingers half-moved. */
function rootsOf(names: Readonly<Record<string, string>>, entry: ProjectEntry): string[] {
  const stale = Object.keys(names).filter((root) => !entry.roots.includes(root) && cleanProjectName(names[root]!) === entry.name);
  return [...entry.roots, ...stale];
}

function find(catalogue: readonly ProjectEntry[], project: string): ProjectEntry | ProjectEditResult {
  if (project === NOT_ASSIGNED) return fail(NOT_ASSIGNED_ERROR);
  return catalogue.find((entry) => entry.name === project) ?? fail(`No project named ${quoted(cleanProjectName(project))}.`);
}

const isEntry = (value: ProjectEntry | ProjectEditResult): value is ProjectEntry => !('ok' in value);

/**
 * The names map after `changes` (root → new name, or null to remove it), with nothing else moving:
 * - a name another project shows is a merge with it, so its folders get that name too; otherwise a new folder that later
 *   took the made-up name would undo the merge;
 * - every other root keeps the name it shows now. Changing which roots are unnamed can change the names made up for the
 *   rest (`a/cli` becomes `cli` once `b/cli` has a name), so such a root gets its current name as its own.
 */
export function settleNames(names: Readonly<Record<string, string>>, ledger: Ledger, home: string, changes: ReadonlyMap<string, string | null>): Record<string, string> {
  const roots = ledgerProjectRoots(ledger);
  const before = projectDisplayNames(roots, names, home);
  const next = { ...names };
  for (const [root, name] of changes) {
    if (name === null) delete next[root];
    else next[root] = name;
  }
  const given = new Set([...changes.values()].filter((name): name is string => name !== null));
  for (const root of roots) {
    if (!changes.has(root) && next[root] === undefined && given.has(before.get(root)!)) next[root] = before.get(root)!;
  }
  // Pinning a root takes its name out of the made-up pool, which can move another; a few rounds settle it.
  for (let round = 0; round <= roots.length; round += 1) {
    const after = projectDisplayNames(roots, next, home);
    const moved = roots.filter((root) => !changes.has(root) && next[root] === undefined && after.get(root) !== before.get(root));
    if (moved.length === 0) break;
    for (const root of moved) next[root] = before.get(root)!;
  }
  return next;
}

function nameAll(roots: readonly string[], name: string | null): Map<string, string | null> {
  return new Map(roots.map((root) => [root, name]));
}

/** Gives every root of both projects the name of `into`, so they count as one. */
export function mergeProjectNames(names: Readonly<Record<string, string>>, ledger: Ledger, project: string, into: string, home: string): ProjectEditResult {
  const catalogue = projectCatalogue(projectRows(ledger, names, home));
  const from = find(catalogue, project);
  if (!isEntry(from)) return from;
  const to = find(catalogue, into);
  if (!isEntry(to)) return to;
  if (from.name === to.name) return fail(`${quoted(from.name)} cannot be merged with itself.`);
  return {
    ok: true,
    names: settleNames(names, ledger, home, nameAll([...rootsOf(names, from), ...rootsOf(names, to)], to.name)),
    message: `Merged ${quoted(from.name)} into ${quoted(to.name)}.`,
    select: to.name,
  };
}

/** Gives a project a new name. A name another project already has is a merge, and the message says so. */
export function renameProjectNames(names: Readonly<Record<string, string>>, ledger: Ledger, project: string, name: string, home: string): ProjectEditResult {
  const catalogue = projectCatalogue(projectRows(ledger, names, home));
  const entry = find(catalogue, project);
  if (!isEntry(entry)) return entry;
  const clean = cleanProjectName(name);
  if (clean === '') return fail('A project name needs at least one visible character.');
  if (clean.toLowerCase() === NOT_ASSIGNED.toLowerCase()) return fail(`"${NOT_ASSIGNED}" is the row for usage with no known project; it cannot be a project's name.`);
  if (clean === entry.name) return fail(`It is already called ${quoted(clean)}.`);
  const other = catalogue.some((candidate) => candidate.name === clean);
  return {
    ok: true,
    names: settleNames(names, ledger, home, nameAll(rootsOf(names, entry), clean)),
    message: other
      ? `Renamed ${quoted(entry.name)} to ${quoted(clean)}. Another project has that name, so they now count as one.`
      : `Renamed ${quoted(entry.name)} to ${quoted(clean)}.`,
    select: clean,
  };
}

/** Removes the names of a project's roots, so each folder is its own project again. Only a project with 2+ folders splits. */
export function splitProjectNames(names: Readonly<Record<string, string>>, ledger: Ledger, project: string, home: string): ProjectEditResult {
  const catalogue = projectCatalogue(projectRows(ledger, names, home));
  const entry = find(catalogue, project);
  if (!isEntry(entry)) return entry;
  if (entry.roots.length < 2) return fail(`${quoted(entry.name)} has one folder, so there is nothing to split.`);
  const next = settleNames(names, ledger, home, nameAll(rootsOf(names, entry), null));
  // The names the view will show: the same roots and names `projectRows` works from. Biggest folder first.
  const shown = projectDisplayNames(ledgerProjectRoots(ledger), next, home);
  const parts = [...new Set(entry.roots.map((root) => shown.get(root)!))];
  return {
    ok: true,
    names: next,
    message: `Split ${quoted(entry.name)} into ${parts.map(quoted).join(', ')}.`,
    select: parts[0]!,
  };
}

/** Applies one edit to the names map. The caller reads the config right before and writes the result straight after. */
export function planProjectEdit(edit: ProjectEdit, names: Readonly<Record<string, string>>, ledger: Ledger, home: string): ProjectEditResult {
  switch (edit.projects) {
    case 'merge':
      return mergeProjectNames(names, ledger, edit.project, edit.into, home);
    case 'rename':
      return renameProjectNames(names, ledger, edit.project, edit.name, home);
    case 'split':
      return splitProjectNames(names, ledger, edit.project, home);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Suggestions

/** Why another project is likely the same one, strongest first. */
export type MergeReason = 'same-name' | 'parent-name' | 'similar-name' | 'same-folder';

export interface MergeCandidate {
  name: string;
  weighted: number;
  folders: number;
  /** Null when nothing suggests the two belong together. */
  reason: MergeReason | null;
}

/** Words that name a part of a product rather than the product: `tokengraph-cli` and `tokengraph-site` are one family. */
const PART_WORDS = new Set(['cli', 'site', 'web', 'website', 'www', 'app', 'api', 'server', 'client', 'frontend', 'backend', 'docs', 'ui', 'core', 'mobile', 'ios', 'android', 'desktop', 'landing', 'old', 'new', 'next', 'v2']);
/** The shortest name that counts when one name is found inside another; shorter ones match by chance. */
const MIN_CONTAINED = 4;
/** A folder that holds more project roots than this is a place for projects, not one project's family. */
const MAX_FAMILY = 6;
const HASH_SUFFIX = /-[0-9a-f]{4}$/;

function words(name: string): string[] {
  return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The name without separators, and without part words when something else is left. */
function stems(name: string): { whole: string; stem: string } {
  const all = words(name);
  const kept = all.filter((word) => !PART_WORDS.has(word));
  return { whole: all.join(''), stem: (kept.length > 0 ? kept : all).join('') };
}

const basename = (root: string): string => root.split('/').filter(Boolean).at(-1) ?? '';
const parentOf = (root: string): string => root.slice(0, Math.max(0, root.lastIndexOf('/')));

interface Aliases {
  /** Its own name and the last part of each of its folders. A name the view made up (`a/cli`, `cli-1f2e`) adds nothing. */
  names: string[];
  /** For each folder, its parent's name alone and in front of the folder's: `tokengraph/cli` is tokengraph, and tokengraph-cli. */
  parents: string[];
}

function aliases(entry: ProjectEntry, parentOfRoot: (root: string) => string | null): Aliases {
  const folders = entry.roots.map(basename).filter(Boolean);
  const last = entry.name.split('/').at(-1) ?? entry.name;
  const madeUp = entry.name.includes('/') || folders.some((folder) => HASH_SUFFIX.test(last) && last.slice(0, -5) === folder);
  const parents = entry.roots.flatMap((root) => {
    const parent = parentOfRoot(root);
    return parent === null ? [] : [basename(parent), `${basename(parent)}-${basename(root)}`];
  });
  return { names: [...new Set(madeUp ? folders : [entry.name, ...folders])], parents: [...new Set(parents)] };
}

const sameStem = (a: string, b: string): boolean => {
  const left = stems(a);
  const right = stems(b);
  // A name of symbols only has no words to compare.
  return left.whole !== '' && right.whole !== '' && (left.stem === right.stem || left.whole === right.whole);
};

/** One name inside the other, when the shorter one is long enough not to match by chance. */
const holds = (a: string, b: string): boolean => {
  const left = stems(a);
  const right = stems(b);
  return (left.stem.length >= MIN_CONTAINED && right.whole.includes(left.stem)) || (right.stem.length >= MIN_CONTAINED && left.whole.includes(right.stem));
};

const any = (lefts: readonly string[], rights: readonly string[], test: (a: string, b: string) => boolean): boolean => lefts.some((left) => rights.some((right) => test(left, right)));

/** A parent's name is held against the other project's own names only: two siblings share a parent by definition. */
function nameReason(a: Aliases, b: Aliases): MergeReason | null {
  if (any(a.names, b.names, sameStem)) return 'same-name';
  if (any(a.parents, b.names, sameStem) || any(a.names, b.parents, sameStem)) return 'parent-name';
  return any(a.names, b.names, holds) ? 'similar-name' : null;
}

/**
 * Every other assigned project, the ones likely to be the same project first: the same name once case, separators, a
 * made-up hash and part words like `-cli` or `-site` are ignored; then one in a folder named like the other
 * (`tokengraph/cli` and `token-graph` or `tokengraph-cli`); then one name inside the other; then folders side by side
 * in a small parent folder. Within each group, and for the rest, the biggest all-time usage comes first.
 */
export function suggestMerges(rows: readonly ProjectRow[], project: string, home: string): MergeCandidate[] {
  const catalogue = projectCatalogue(rows);
  const self = catalogue.find((entry) => entry.name === project);
  const homeFolder = normaliseFolder(home);
  const families = new Map<string, number>();
  for (const root of catalogue.flatMap((entry) => entry.roots)) families.set(parentOf(root), (families.get(parentOf(root)) ?? 0) + 1);
  // A parent says something about a project unless it is the home folder or the top of a disk.
  const named = (root: string): string | null => {
    const parent = parentOf(root);
    return parent === '' || parent === homeFolder || /^[a-z]:$/i.test(parent) ? null : parent;
  };
  // Folders side by side only count in a small folder that is not the one people keep every project in (`~/code`).
  const family = (root: string): string | null => {
    const parent = named(root);
    const size = parent === null ? 0 : families.get(parent)!;
    return parent === null || parentOf(parent) === homeFolder || size < 2 || size > MAX_FAMILY ? null : parent;
  };
  const ownParents = new Set((self?.roots ?? []).map(family).filter((parent): parent is string => parent !== null));
  const ownAliases = self ? aliases(self, named) : { names: [project], parents: [] };
  const rank: Record<MergeReason, number> = { 'same-name': 0, 'parent-name': 1, 'similar-name': 2, 'same-folder': 3 };

  return catalogue
    .filter((entry) => entry.name !== project)
    .map((entry): MergeCandidate => {
      const reason = nameReason(ownAliases, aliases(entry, named)) ?? (entry.roots.some((root) => ownParents.has(family(root) ?? '')) ? 'same-folder' : null);
      return { name: entry.name, weighted: entry.weighted, folders: entry.roots.length, reason };
    })
    .sort((a, b) => (a.reason === null ? 4 : rank[a.reason]) - (b.reason === null ? 4 : rank[b.reason]) || b.weighted - a.weighted || a.name.localeCompare(b.name));
}
