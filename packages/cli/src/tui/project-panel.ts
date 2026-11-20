import { projectCatalogue, suggestMerges, type MergeCandidate, type ProjectEdit } from '../project-names.js';
import { cleanProjectName, NOT_ASSIGNED, stripControl, type ProjectRow } from '../project-usage.js';
import { normaliseFolder } from '../project-roots.js';
import type { InputEvent } from './input.js';

/** The longest filter or name the boxes take; a project name is cut to this anyway (`cleanProjectName`). */
const MAX_TEXT = 60;
/** Rows ↑↓ skip on PgUp / PgDn in the merge list. */
const PAGE = 8;

/** "Merge «A» with…": pick another project from a list, filtered by typing, then choose which name stays. */
export interface MergePanel {
  kind: 'merge';
  project: string;
  /** All-time weighted tokens and folders of `project`, for the confirm step's total. */
  weighted: number;
  folders: number;
  /** Every other assigned project, likely matches first (`suggestMerges`). */
  candidates: MergeCandidate[];
  filter: string;
  /** Index into `shownCandidates(panel)`. */
  selected: number;
  /** The confirm step: the project picked and whose name the merged project keeps. */
  confirm: { other: string; keep: 'project' | 'other' } | null;
}

/** A one-line text input holding the new name, with a cursor. */
export interface RenamePanel {
  kind: 'rename';
  project: string;
  text: string;
  /** Characters before the cursor. */
  cursor: number;
  /** The other projects' names: taking one merges, and the box says so before Enter. */
  others: string[];
  error: string | null;
}

/** "Split «P» back into its folders?" */
export interface SplitPanel {
  kind: 'split';
  project: string;
  /** Its folders as shown: biggest first, the home folder spelled `~`. */
  folders: string[];
}

export type ProjectPanel = MergePanel | RenamePanel | SplitPanel;
export type ProjectPanelKind = ProjectPanel['kind'];

/** What the box asks the app to do. Every command ends the box; an edit is applied after it closes. */
export type ProjectCommand = ProjectEdit | { projects: 'close' };

const VERB: Record<ProjectPanelKind, string> = { merge: 'merged', rename: 'renamed', split: 'split' };

function tilde(folder: string, home: string): string {
  const base = normaliseFolder(home);
  const clean = stripControl(folder);
  return clean === base ? '~' : clean.startsWith(`${base}/`) ? `~${clean.slice(base.length)}` : clean;
}

/**
 * Opens a box for `project`, given the view's all-time project rows. Returns the line to show as a toast instead when
 * there is nothing to do: Not assigned, no other project to merge with, or one folder to split.
 */
export function openProjectPanel(kind: ProjectPanelKind, rows: readonly ProjectRow[], project: string, home: string): ProjectPanel | string {
  // Short enough to fit beside the key hints on an 80-column screen.
  if (project === NOT_ASSIGNED) return `${NOT_ASSIGNED} cannot be ${VERB[kind]}.`;
  const catalogue = projectCatalogue(rows);
  const entry = catalogue.find((candidate) => candidate.name === project);
  if (!entry) return `No usage recorded for ${project} yet.`;
  switch (kind) {
    case 'merge': {
      const candidates = suggestMerges(rows, project, home);
      if (candidates.length === 0) return 'No other project to merge with.';
      return { kind, project, weighted: entry.weighted, folders: entry.roots.length, candidates, filter: '', selected: 0, confirm: null };
    }
    case 'rename':
      return { kind, project, text: project, cursor: [...project].length, others: catalogue.map((other) => other.name).filter((name) => name !== project), error: null };
    case 'split': {
      if (entry.roots.length < 2) return `${project} has one folder: nothing to split.`;
      return { kind, project, folders: entry.roots.map((root) => tilde(root, home)) };
    }
  }
}

/** The candidates the filter lets through, in their ranked order. The filter matches anywhere in a name, ignoring case. */
export function shownCandidates(panel: MergePanel): MergeCandidate[] {
  const needle = panel.filter.toLowerCase();
  return needle === '' ? panel.candidates : panel.candidates.filter((candidate) => candidate.name.toLowerCase().includes(needle));
}

/** The name Enter would give in the rename box, and whether another project has it; null while there is none to give. */
export function renameTarget(panel: RenamePanel): { name: string; merges: boolean } | null {
  const name = cleanProjectName(panel.text);
  if (name === '' || name === panel.project || name.toLowerCase() === NOT_ASSIGNED.toLowerCase()) return null;
  return { name, merges: panel.others.includes(name) };
}

/** The merge the confirm step would make: the kept name is always the one merged into. */
export function mergeEdit(panel: MergePanel): ProjectEdit | null {
  if (!panel.confirm) return null;
  const { other, keep } = panel.confirm;
  return keep === 'other' ? { projects: 'merge', project: panel.project, into: other } : { projects: 'merge', project: other, into: panel.project };
}

/** Printable text from a key press or a paste, without control characters. */
function typed(event: InputEvent): string | null {
  if (event.type !== 'char') return null;
  const text = stripControl(event.char);
  return text === '' ? null : text;
}

const isKey = (event: InputEvent, ...keys: string[]): boolean => event.type === 'key' && keys.includes(event.key);
const isCtrl = (event: InputEvent, char: string): boolean => event.type === 'ctrl' && event.char === char;
const close = <P extends ProjectPanel>(panel: P) => ({ panel, command: { projects: 'close' } as ProjectCommand });

function mergeKey(panel: MergePanel, event: InputEvent): { panel: ProjectPanel; command: ProjectCommand | null } {
  const stay = { panel, command: null };
  if (panel.confirm) {
    if (isKey(event, 'escape')) return { panel: { ...panel, confirm: null }, command: null };
    if (isKey(event, 'left', 'right', 'up', 'down', 'tab', 'backtab')) {
      return { panel: { ...panel, confirm: { ...panel.confirm, keep: panel.confirm.keep === 'other' ? 'project' : 'other' } }, command: null };
    }
    if (isKey(event, 'enter')) return { panel, command: mergeEdit(panel) };
    return stay;
  }
  const shown = shownCandidates(panel);
  const last = Math.max(0, shown.length - 1);
  const move = (to: number) => ({ panel: { ...panel, selected: Math.min(last, Math.max(0, to)) }, command: null });
  if (isKey(event, 'escape')) return close(panel);
  if (isKey(event, 'up') || (event.type === 'mouse' && event.action === 'wheelup')) return move(panel.selected - 1);
  if (isKey(event, 'down') || (event.type === 'mouse' && event.action === 'wheeldown')) return move(panel.selected + 1);
  if (isKey(event, 'pageup')) return move(panel.selected - PAGE);
  if (isKey(event, 'pagedown')) return move(panel.selected + PAGE);
  if (isKey(event, 'home')) return move(0);
  if (isKey(event, 'end')) return move(last);
  if (isKey(event, 'enter')) {
    const picked = shown[panel.selected];
    if (!picked) return stay;
    // The bigger project usually is the one the other belongs to, so its name is the one offered first.
    const keep = picked.weighted > panel.weighted ? 'other' : 'project';
    return { panel: { ...panel, confirm: { other: picked.name, keep } }, command: null };
  }
  const refilter = (filter: string) => ({ panel: { ...panel, filter, selected: 0 }, command: null });
  if (isKey(event, 'backspace')) return refilter([...panel.filter].slice(0, -1).join(''));
  if (isCtrl(event, 'u')) return refilter('');
  const text = typed(event);
  if (text !== null) return refilter([...(panel.filter + text)].slice(0, MAX_TEXT).join(''));
  return stay;
}

function renameKey(panel: RenamePanel, event: InputEvent): { panel: ProjectPanel; command: ProjectCommand | null } {
  const chars = [...panel.text];
  const edit = (next: string[], cursor: number) => ({ panel: { ...panel, text: next.join(''), cursor: Math.min(next.length, Math.max(0, cursor)), error: null }, command: null });
  const at = (cursor: number) => ({ panel: { ...panel, cursor: Math.min(chars.length, Math.max(0, cursor)) }, command: null });
  if (isKey(event, 'escape')) return close(panel);
  if (isKey(event, 'enter')) {
    const name = cleanProjectName(panel.text);
    if (name === '') return { panel: { ...panel, error: 'A name needs at least one visible character.' }, command: null };
    if (name.toLowerCase() === NOT_ASSIGNED.toLowerCase()) return { panel: { ...panel, error: `"${NOT_ASSIGNED}" is kept for usage with no known project.` }, command: null };
    if (name === panel.project) return close(panel);
    return { panel, command: { projects: 'rename', project: panel.project, name } };
  }
  if (isKey(event, 'left')) return at(panel.cursor - 1);
  if (isKey(event, 'right')) return at(panel.cursor + 1);
  if (isKey(event, 'home') || isCtrl(event, 'a')) return at(0);
  if (isKey(event, 'end') || isCtrl(event, 'e')) return at(chars.length);
  if (isKey(event, 'backspace')) {
    if (panel.cursor === 0) return { panel, command: null };
    return edit([...chars.slice(0, panel.cursor - 1), ...chars.slice(panel.cursor)], panel.cursor - 1);
  }
  if (isCtrl(event, 'u')) return edit(chars.slice(panel.cursor), 0);
  if (isCtrl(event, 'k')) return edit(chars.slice(0, panel.cursor), panel.cursor);
  const text = typed(event);
  if (text !== null) {
    const room = MAX_TEXT - chars.length;
    if (room <= 0) return { panel, command: null };
    const added = [...text].slice(0, room);
    return edit([...chars.slice(0, panel.cursor), ...added, ...chars.slice(panel.cursor)], panel.cursor + added.length);
  }
  return { panel, command: null };
}

function splitKey(panel: SplitPanel, event: InputEvent): { panel: ProjectPanel; command: ProjectCommand | null } {
  if (isKey(event, 'enter') || (event.type === 'char' && (event.char === 'y' || event.char === 'Y'))) {
    return { panel, command: { projects: 'split', project: panel.project } };
  }
  if (isKey(event, 'escape') || (event.type === 'char' && (event.char === 'n' || event.char === 'N'))) return close(panel);
  return { panel, command: null };
}

/**
 * Keys while a box is open; nothing reaches the app. Ctrl-C closes from anywhere, Esc closes (or, on the merge confirm
 * step, goes back to the list). Any command ends the box: the app drops it and applies the edit.
 */
export function projectPanelKey(panel: ProjectPanel, event: InputEvent): { panel: ProjectPanel; command: ProjectCommand | null } {
  if (isCtrl(event, 'c')) return close(panel);
  switch (panel.kind) {
    case 'merge':
      return mergeKey(panel, event);
    case 'rename':
      return renameKey(panel, event);
    case 'split':
      return splitKey(panel, event);
  }
}
