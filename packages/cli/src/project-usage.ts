import { createHash } from 'node:crypto';
import {
  addCounts,
  agentName,
  displayModelName,
  emptyCounts,
  KNOWN_SOURCES,
  modelLabel,
  weightedTokens,
  type KnownSource,
  type PricingTier,
  type SplitTokenCounts,
  type TokenCounts,
} from '@tokengraph/core';
import { allLedgerUsage, projectUsageRows, type Ledger } from './ledger.js';
import { normaliseFolder } from './project-roots.js';
import type { Breakdown } from './tui/model.js';
import { addCost, emptyCost, rangeStart, rowCost, SERIES_DAYS, shiftDate, type CostSummary, type RangeKey } from './tui/usage-math.js';

/** The row for usage with no known project. It is never spread across projects. */
export const NOT_ASSIGNED = 'Not assigned';

const HOME_FOLDER = 'Home folder';
const MAX_NAME_LENGTH = 60;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Text from disk goes to a terminal, where a control character would be an instruction. */
export function stripControl(raw: string): string {
  return raw.replace(CONTROL, '');
}

export function cleanProjectName(raw: string): string {
  return [...stripControl(raw).trim()].slice(0, MAX_NAME_LENGTH).join('').trim();
}

function tail(root: string, segments: number): string {
  return root.split('/').filter(Boolean).slice(-segments).join('/');
}

/** root → the name people see. A user's name wins; roots that end up with one name are one project. */
export function projectDisplayNames(roots: Iterable<string>, names: Readonly<Record<string, string>>, home: string): Map<string, string> {
  const homeFolder = normaliseFolder(home);
  const result = new Map<string, string>();
  const unnamed: string[] = [];
  for (const root of new Set(roots)) {
    const own = names[root] === undefined ? '' : cleanProjectName(names[root]);
    if (own !== '') result.set(root, own);
    else if (root === homeFolder || tail(root, 1) === '') result.set(root, HOME_FOLDER);
    else unnamed.push(root);
  }
  // The folder, then its parent too. Past that a path would start to show a user name, so a short hash tells them apart.
  let pending = unnamed;
  for (const segments of [1, 2]) {
    const counts = new Map<string, number>();
    const spelled = pending.map((root) => [root, cleanProjectName(tail(root, segments))] as const);
    for (const [, name] of spelled) counts.set(name, (counts.get(name) ?? 0) + 1);
    const next: string[] = [];
    for (const [root, name] of spelled) {
      if (counts.get(name)! > 1 || name === NOT_ASSIGNED) next.push(root);
      else result.set(root, name);
    }
    pending = next;
  }
  for (const root of pending) result.set(root, `${cleanProjectName(tail(root, 1))}-${createHash('sha256').update(root).digest('hex').slice(0, 4)}`);
  return result;
}

export interface ProjectRow {
  project: string;
  /** The project root, or null on a Not assigned row. */
  folder: string | null;
  source: KnownSource;
  date: string;
  model: string;
  pricingTier: PricingTier;
  counts: SplitTokenCounts;
}

const BASE = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const;

/** What is left of `total` after `want` is taken from it, base field by base field. An unknowable split stays null. */
function take(total: SplitTokenCounts, want: SplitTokenCounts): { taken: SplitTokenCounts; rest: SplitTokenCounts } {
  const taken = { ...want };
  const rest = { ...total };
  let capped = false;
  for (const field of BASE) {
    taken[field] = Math.min(total[field], want[field]);
    rest[field] = total[field] - taken[field];
    capped ||= taken[field] !== want[field];
  }
  if (capped) {
    // A null split prices the row as unknown, so a capped row keeps a split that adds up to what it took.
    const known = want.cacheCreation5mTokens !== null && want.cacheCreation1hTokens !== null;
    taken.cacheCreation5mTokens = known ? Math.min(want.cacheCreation5mTokens!, taken.cacheCreationTokens) : null;
    taken.cacheCreation1hTokens = known ? taken.cacheCreationTokens - taken.cacheCreation5mTokens! : null;
  }
  const left = (whole: number | null, part: number | null): number | null => (whole === null || part === null ? null : Math.max(0, whole - part));
  rest.cacheCreation5mTokens = left(total.cacheCreation5mTokens, taken.cacheCreation5mTokens);
  rest.cacheCreation1hTokens = left(total.cacheCreation1hTokens, taken.cacheCreation1hTokens);
  return { taken, rest };
}

function isEmpty(counts: SplitTokenCounts): boolean {
  return BASE.every((field) => counts[field] === 0);
}

function rowKey(source: string, date: string, model: string, tier: string): string {
  return `${source}\0${date}\0${model}\0${tier}`;
}

/**
 * Splits every combined total of the ledger between projects. The totals come from `allLedgerUsage`, so Cursor's account
 * rule stays in one place. Folders take from a total largest first and can never exceed it, so projects plus Not assigned
 * always add up to what the rest of the view shows.
 */
export function projectRows(ledger: Ledger, names: Readonly<Record<string, string>>, home: string): ProjectRow[] {
  const storedRoots = ledger.projects?.roots ?? {};
  const pending = new Map<string, { root: string; counts: SplitTokenCounts }[]>();
  for (const source of KNOWN_SOURCES) {
    for (const row of projectUsageRows(ledger, source)) {
      const key = rowKey(source, row.date, row.model, row.pricingTier);
      pending.set(key, [...(pending.get(key) ?? []), { root: storedRoots[row.folder] ?? row.folder, counts: row.counts }]);
    }
  }
  const display = projectDisplayNames([...pending.values()].flat().map((entry) => entry.root), names, home);

  const rows: ProjectRow[] = [];
  for (const { source, date, model, pricingTier, counts } of allLedgerUsage(ledger)) {
    const key = rowKey(source, date, model, pricingTier);
    const shares = (pending.get(key) ?? []).sort((a, b) => weightedTokens(b.counts) - weightedTokens(a.counts) || a.root.localeCompare(b.root));
    pending.delete(key);
    let rest = counts;
    for (const share of shares) {
      const { taken, rest: left } = take(rest, share.counts);
      rest = left;
      if (!isEmpty(taken)) rows.push({ project: display.get(share.root) ?? NOT_ASSIGNED, folder: share.root, source, date, model, pricingTier, counts: taken });
    }
    if (!isEmpty(rest)) rows.push({ project: NOT_ASSIGNED, folder: null, source, date, model, pricingTier, counts: rest });
  }
  return rows;
}

export interface ProjectShare {
  key: string;
  name: string;
  weighted: number;
  /** 0..1 of the whole this row is part of. */
  share: number;
  cost: CostSummary;
}

export interface ProjectSummary extends Breakdown {
  folders: string[];
  models: ProjectShare[];
  agents: ProjectShare[];
  /** False only on the Not assigned row. */
  assigned: boolean;
}

interface Tally {
  weighted: number;
  cost: CostSummary;
  name: string;
}

function tally(map: Map<string, Tally>, key: string, name: string, weighted: number, cost: CostSummary): void {
  const entry = map.get(key) ?? { weighted: 0, cost: emptyCost(), name };
  entry.weighted += weighted;
  entry.cost = addCost(entry.cost, cost);
  map.set(key, entry);
}

function shares(map: Map<string, Tally>, total: number): ProjectShare[] {
  return [...map]
    .map(([key, { weighted, cost, name }]) => ({ key, name, weighted, cost, share: total > 0 ? weighted / total : 0 }))
    .sort((a, b) => b.weighted - a.weighted || a.key.localeCompare(b.key));
}

function rangeFilter(range: RangeKey, today: string): (date: string) => boolean {
  const start = rangeStart(range, today);
  return (date) => date <= today && (start === null || date >= start);
}

function baseCounts(counts: SplitTokenCounts): TokenCounts {
  const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = counts;
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** One row per project active in the range, biggest first, with Not assigned always last. */
export function summariseProjects(rows: readonly ProjectRow[], range: RangeKey, today: string): ProjectSummary[] {
  const include = rangeFilter(range, today);
  const seriesStart = shiftDate(today, -(SERIES_DAYS - 1));
  const groups = new Map<string, { weighted: number; counts: TokenCounts; cost: CostSummary; lastActive: string; daily30: number[]; folders: Set<string>; models: Map<string, Tally>; agents: Map<string, Tally> }>();
  const group = (name: string) => {
    let entry = groups.get(name);
    if (!entry) {
      entry = { weighted: 0, counts: emptyCounts(), cost: emptyCost(), lastActive: '', daily30: new Array<number>(SERIES_DAYS).fill(0), folders: new Set(), models: new Map(), agents: new Map() };
      groups.set(name, entry);
    }
    return entry;
  };

  // The sparkline is a fixed 30-day window, whatever range chose the rows, but a project shows only if the range has it.
  const active = new Set(rows.filter((row) => include(row.date)).map((row) => row.project));
  let total = 0;
  for (const row of rows) {
    if (!active.has(row.project)) continue;
    const entry = group(row.project);
    const weighted = weightedTokens(row.counts);
    if (row.date >= seriesStart && row.date <= today) entry.daily30[SERIES_DAYS - 1 - daysBetween(row.date, today)]! += weighted;
    if (!include(row.date)) continue;
    const cost = rowCost(row.model, row.date, row.counts, row.pricingTier);
    const label = modelLabel(row.model);
    total += weighted;
    entry.weighted += weighted;
    entry.counts = addCounts(entry.counts, baseCounts(row.counts));
    entry.cost = addCost(entry.cost, cost);
    if (row.date > entry.lastActive) entry.lastActive = row.date;
    if (row.folder !== null) entry.folders.add(row.folder);
    tally(entry.models, label, displayModelName(label), weighted, cost);
    tally(entry.agents, row.source, agentName(row.source), weighted, cost);
  }

  return [...groups]
    .map(([name, entry]): ProjectSummary => ({
      key: name,
      name,
      family: null,
      weighted: entry.weighted,
      share: total > 0 ? entry.weighted / total : 0,
      counts: entry.counts,
      cost: entry.cost,
      lastActive: entry.lastActive,
      daily30: entry.daily30,
      folders: [...entry.folders].sort(),
      models: shares(entry.models, entry.weighted),
      agents: shares(entry.agents, entry.weighted),
      assigned: name !== NOT_ASSIGNED,
    }))
    .sort((a, b) => Number(b.assigned) - Number(a.assigned) || b.weighted - a.weighted || a.key.localeCompare(b.key));
}

/** The biggest projects of one model label or one agent in the range. Their shares are of that model's or agent's whole usage. */
export function topProjects(rows: readonly ProjectRow[], by: 'model' | 'agent', key: string, range: RangeKey, today: string, limit: number): ProjectShare[] {
  const include = rangeFilter(range, today);
  const projects = new Map<string, Tally>();
  let total = 0;
  for (const row of rows) {
    if (!include(row.date) || (by === 'model' ? modelLabel(row.model) : row.source) !== key) continue;
    const weighted = weightedTokens(row.counts);
    total += weighted;
    if (row.project !== NOT_ASSIGNED) tally(projects, row.project, row.project, weighted, rowCost(row.model, row.date, row.counts, row.pricingTier));
  }
  return shares(projects, total).slice(0, limit);
}
