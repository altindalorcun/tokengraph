import { describe, expect, it } from 'vitest';
import type { ProjectUsage } from '@tokengraph/core';
import { emptyLedger, mergeProjectRoots, mergeProjects, mergeUsage } from '../../src/ledger.js';
import { NOT_ASSIGNED, projectRows, type ProjectRow } from '../../src/project-usage.js';
import { mergeEdit, openProjectPanel, projectPanelKey, renameTarget, shownCandidates, type MergePanel, type ProjectPanel, type RenamePanel, type SplitPanel } from '../../src/tui/project-panel.js';
import type { InputEvent } from '../../src/tui/input.js';
import { ScreenBuffer, toPlainText } from '../../src/tui/screen.js';
import { tuiTheme } from '../../src/tui/theme.js';
import { drawProjectPanel } from '../../src/tui/views/project-panel.js';

const HOME = '/Users/me';
const counts = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });
const CLI = `${HOME}/codes/tokengraph/cli`;
const SITE = `${HOME}/codes/tokengraph/tokengraph-site`;
const OLD = `${HOME}/codes/token-graph`;
const BLOG = `${HOME}/codes/blog`;
const NOTES = `${HOME}/codes/notes`;
const DOTS = `${HOME}/codes/dotfiles`;
const FOLDERS = { [CLI]: 6000, [SITE]: 3000, [OLD]: 2000, [BLOG]: 800, [NOTES]: 100, [DOTS]: 50 };

function rows(names: Record<string, string> = {}, folders: Record<string, number> = FOLDERS): ProjectRow[] {
  const total = Object.values(folders).reduce((sum, n) => sum + n, 0);
  const usage: ProjectUsage[] = Object.entries(folders).map(([folder, n]) => ({ folder, date: '2026-10-30', model: 'claude-opus-4-8', pricingTier: 'standard', counts: counts(n) }));
  const ledger = mergeProjectRoots(
    mergeProjects(mergeUsage(emptyLedger(), 'claude-code', [{ date: '2026-10-30', model: 'claude-opus-4-8', pricingTier: 'standard', counts: counts(total + 100) }]), 'claude-code', usage),
    Object.fromEntries(Object.keys(folders).map((folder) => [folder, folder])),
  );
  return projectRows(ledger, names, HOME);
}

const key = (name: 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown' | 'tab' | 'enter' | 'escape' | 'backspace'): InputEvent => ({ type: 'key', key: name });
const char = (c: string): InputEvent => ({ type: 'char', char: c });
const ctrl = (c: string): InputEvent => ({ type: 'ctrl', char: c });

function press(panel: ProjectPanel, ...events: InputEvent[]): ProjectPanel {
  return events.reduce((current, event) => projectPanelKey(current, event).panel, panel);
}
function open<K extends ProjectPanel['kind']>(kind: K, project: string, names: Record<string, string> = {}): Extract<ProjectPanel, { kind: K }> {
  const panel = openProjectPanel(kind, rows(names), project, HOME);
  if (typeof panel === 'string') throw new Error(panel);
  return panel as Extract<ProjectPanel, { kind: K }>;
}
const type = (panel: ProjectPanel, text: string) => press(panel, ...[...text].map(char));

describe('openProjectPanel', () => {
  it('refuses Not assigned, a lone project and a one-folder split with a line for a toast', () => {
    for (const kind of ['merge', 'rename', 'split'] as const) {
      expect(openProjectPanel(kind, rows(), NOT_ASSIGNED, HOME)).toBe(`Not assigned cannot be ${kind === 'merge' ? 'merged' : kind === 'rename' ? 'renamed' : 'split'}.`);
    }
    expect(openProjectPanel('merge', rows({}, { [CLI]: 10 }), 'cli', HOME)).toBe('No other project to merge with.');
    expect(openProjectPanel('split', rows(), 'cli', HOME)).toBe('cli has one folder: nothing to split.');
    expect(openProjectPanel('rename', rows(), 'gone', HOME)).toBe('No usage recorded for gone yet.');
  });

  it('lists the other projects for a merge, likely matches first, with tokens and folders', () => {
    const panel = open('merge', 'token-graph');
    expect(panel).toMatchObject({ project: 'token-graph', weighted: 2000, folders: 1, filter: '', selected: 0, confirm: null });
    expect(panel.candidates.map((c) => [c.name, c.reason])).toEqual([
      ['tokengraph-site', 'same-name'],
      ['cli', 'parent-name'],
      ['blog', null],
      ['notes', null],
      ['dotfiles', null],
    ]);
  });

  it('starts a rename with the name and the cursor at its end, and a split with its folders biggest first under ~', () => {
    expect(open('rename', 'cli')).toMatchObject({ text: 'cli', cursor: 3, error: null, others: ['tokengraph-site', 'token-graph', 'blog', 'notes', 'dotfiles'] });
    const names = { [OLD]: 'tokengraph', [CLI]: 'tokengraph' };
    expect(open('split', 'tokengraph', names)).toEqual({ kind: 'split', project: 'tokengraph', folders: ['~/codes/tokengraph/cli', '~/codes/token-graph'] });
  });
});

describe('the merge box', () => {
  it('moves without wrapping, filters as you type and starts again at the top', () => {
    let panel: ProjectPanel = open('merge', 'token-graph');
    panel = press(panel, key('up'));
    expect((panel as MergePanel).selected).toBe(0);
    panel = press(panel, key('down'), key('down'), key('pagedown'));
    expect((panel as MergePanel).selected).toBe(4);
    panel = press(panel, key('home'));
    expect((panel as MergePanel).selected).toBe(0);
    panel = press(panel, key('end'), { type: 'mouse', action: 'wheelup', x: 0, y: 0, button: 64 });
    expect((panel as MergePanel).selected).toBe(3);
    panel = type(panel, 'O');
    expect((panel as MergePanel).selected).toBe(0);
    expect(shownCandidates(panel as MergePanel).map((c) => c.name)).toEqual(['tokengraph-site', 'blog', 'notes', 'dotfiles']);
    panel = type(panel, 'tes');
    expect(shownCandidates(panel as MergePanel).map((c) => c.name)).toEqual(['notes']);
    panel = press(panel, key('backspace'), key('backspace'), key('backspace'));
    expect((panel as MergePanel).filter).toBe('O');
    panel = press(panel, ctrl('u'));
    expect((panel as MergePanel).filter).toBe('');
  });

  it('keeps q, digits and other app keys as filter text, and drops control characters', () => {
    const panel = type(open('merge', 'cli'), 'q1\u009b') as MergePanel;
    expect(panel.filter).toBe('q1');
    expect(projectPanelKey(panel, key('enter'))).toEqual({ panel, command: null });
  });

  it('confirms with the bigger project\'s name first, toggles the name and merges into the kept one', () => {
    const list = open('merge', 'token-graph');
    const confirm = press(list, key('down'), key('enter')) as MergePanel;
    expect(confirm.confirm).toEqual({ other: 'cli', keep: 'other' });
    expect(projectPanelKey(confirm, key('enter')).command).toEqual({ projects: 'merge', project: 'token-graph', into: 'cli' });
    const flipped = press(confirm, key('left')) as MergePanel;
    expect(flipped.confirm?.keep).toBe('project');
    expect(mergeEdit(flipped)).toEqual({ projects: 'merge', project: 'cli', into: 'token-graph' });
    expect(projectPanelKey(flipped, key('enter')).command).toEqual({ projects: 'merge', project: 'cli', into: 'token-graph' });
    expect((press(flipped, key('tab')) as MergePanel).confirm?.keep).toBe('other');
    const smaller = press(list, key('end'), key('enter')) as MergePanel;
    expect(smaller.confirm).toEqual({ other: 'dotfiles', keep: 'project' });
  });

  it('goes back to the list on Esc, closes from the list on Esc and from anywhere on Ctrl-C', () => {
    const list = press(open('merge', 'cli'), key('down'));
    const confirm = press(list, key('enter'));
    expect(projectPanelKey(confirm, key('escape'))).toEqual({ panel: { ...confirm, confirm: null }, command: null });
    expect(projectPanelKey(list, key('escape')).command).toEqual({ projects: 'close' });
    expect(projectPanelKey(confirm, ctrl('c')).command).toEqual({ projects: 'close' });
  });

  it('does nothing on Enter when the filter hides every project', () => {
    const panel = type(open('merge', 'cli'), 'zzz') as MergePanel;
    expect(shownCandidates(panel)).toEqual([]);
    expect(projectPanelKey(panel, key('enter'))).toEqual({ panel, command: null });
    expect(projectPanelKey(panel, key('down')).panel).toMatchObject({ selected: 0 });
  });
});

describe('the rename box', () => {
  it('edits at the cursor: type, move, backspace, home, end, Ctrl-U and Ctrl-K', () => {
    let panel: ProjectPanel = open('rename', 'cli');
    panel = press(panel, key('backspace'), key('backspace'), key('backspace'));
    expect(panel).toMatchObject({ text: '', cursor: 0 });
    panel = press(panel, key('backspace'), key('left'));
    expect(panel).toMatchObject({ text: '', cursor: 0 });
    panel = type(panel, 'tkngrph');
    panel = press(panel, key('left'), key('left'), key('left'), key('left'));
    panel = type(panel, 'e');
    expect(panel).toMatchObject({ text: 'tknegrph', cursor: 4 });
    panel = press(panel, key('home'), char('X'), key('end'), char('!'));
    expect(panel).toMatchObject({ text: 'Xtknegrph!', cursor: 10 });
    panel = press(panel, ctrl('a'), key('right'), ctrl('k'));
    expect(panel).toMatchObject({ text: 'X', cursor: 1 });
    panel = press(panel, ctrl('e'), ctrl('u'));
    expect(panel).toMatchObject({ text: '', cursor: 0 });
  });

  it('takes a paste at the cursor, caps the length and drops control characters', () => {
    let panel: ProjectPanel = press(open('rename', 'cli'), ctrl('u'));
    panel = type(panel, 'a\u0085b');
    expect(panel).toMatchObject({ text: 'ab', cursor: 2 });
    panel = type(panel, 'x'.repeat(80));
    expect((panel as RenamePanel).text).toHaveLength(60);
    expect((panel as RenamePanel).cursor).toBe(60);
  });

  it('renames on Enter, closes when the name did not change, and refuses an empty name or Not assigned', () => {
    const panel = open('rename', 'cli');
    expect(projectPanelKey(panel, key('enter')).command).toEqual({ projects: 'close' });
    expect(projectPanelKey(type(panel, 'x'), key('enter')).command).toEqual({ projects: 'rename', project: 'cli', name: 'clix' });
    const empty = projectPanelKey(press(panel, ctrl('u'), char(' ')), key('enter'));
    expect(empty.command).toBeNull();
    expect((empty.panel as RenamePanel).error).toContain('visible character');
    expect((type(empty.panel, 'a') as RenamePanel).error).toBeNull();
    const reserved = projectPanelKey(type(press(panel, ctrl('u')), 'not assigned'), key('enter'));
    expect(reserved.command).toBeNull();
    expect((reserved.panel as RenamePanel).error).toContain(NOT_ASSIGNED);
    expect(projectPanelKey(panel, key('escape')).command).toEqual({ projects: 'close' });
  });

  it('says when the new name is another project\'s, which merges them', () => {
    const panel = type(press(open('rename', 'cli'), ctrl('u')), ' blog ') as RenamePanel;
    expect(renameTarget(panel)).toEqual({ name: 'blog', merges: true });
    expect(projectPanelKey(panel, key('enter')).command).toEqual({ projects: 'rename', project: 'cli', name: 'blog' });
    expect(renameTarget(open('rename', 'cli'))).toBeNull();
  });
});

describe('the split box', () => {
  const names = { [OLD]: 'tokengraph', [CLI]: 'tokengraph' };
  it('splits on Enter or y, and closes on Esc, n or Ctrl-C', () => {
    const panel = open('split', 'tokengraph', names);
    for (const event of [key('enter'), char('y')]) expect(projectPanelKey(panel, event).command).toEqual({ projects: 'split', project: 'tokengraph' });
    for (const event of [key('escape'), char('n'), ctrl('c')]) expect(projectPanelKey(panel, event).command).toEqual({ projects: 'close' });
    expect(projectPanelKey(panel, char('q'))).toEqual({ panel, command: null });
  });
});

describe('drawProjectPanel', () => {
  const draw = (panel: ProjectPanel, width = 100, height = 30, theme = tuiTheme('dark')) => {
    const buf = new ScreenBuffer(width, height);
    drawProjectPanel(buf, { x: 0, y: 0, width, height }, panel, theme);
    return { buf, text: toPlainText(buf) };
  };

  it('draws the list with markers, tokens and folders, the reason of the selected row and the keys', () => {
    const { text } = draw(open('merge', 'token-graph'));
    expect(text).toContain('MERGE PROJECTS');
    expect(text).toContain('Merge "token-graph" with…');
    expect(text).toMatch(/▸ ● tokengraph-site +3\.0K +1 folder/);
    expect(text).toMatch(/│ {4}● cli +6\.0K +1 folder/);
    expect(text).toMatch(/│ {6}blog +800 +1 folder/);
    expect(text).toContain('● Same name, ignoring case and parts like -cli');
    expect(text).toContain('enter pick');
    expect(text).toContain('type a name');
    expect(draw(press(open('merge', 'token-graph'), key('down'))).text).toContain('● One sits in a folder named like the other');
    expect(draw(press(open('merge', 'token-graph'), key('down'), key('down'))).text).toContain('● Likely the same project');
  });

  it('draws the confirm step with the total and the name to keep', () => {
    const { text } = draw(press(open('merge', 'token-graph'), key('enter')));
    expect(text).toContain('"token-graph" and "tokengraph-site" will count as one');
    expect(text).toContain('Together: 5.0K tokens, 2 folders.');
    expect(text).toMatch(/▸ tokengraph-site/);
    expect(text).toContain('esc back');
  });

  it('draws the rename field, the merge note and the split folders', () => {
    const rename = draw(type(press(open('rename', 'cli'), ctrl('u')), 'blog'));
    expect(rename.text).toContain('Rename "cli"');
    expect(rename.text).toContain('"blog" is another project, so they will count as one.');
    expect(rename.text).toContain('enter merge');
    const split = draw(open('split', 'tokengraph', { [OLD]: 'tokengraph', [CLI]: 'tokengraph' }));
    expect(split.text).toContain('Split "tokengraph" back into its folders?');
    expect(split.text).toContain('~/codes/tokengraph/cli');
    expect(split.text).toContain('~/codes/token-graph');
  });

  it('keeps the selected row in view in a short window and never draws outside its rect', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/w${i}/p${String(i).padStart(2, '0')}`, 1000 - i]));
    const panel = openProjectPanel('merge', rows({}, many), 'p00', HOME) as MergePanel;
    const moved = press(panel, ...Array.from({ length: 20 }, () => key('down')));
    const { text } = draw(moved, 80, 16);
    expect(text).toMatch(/▸ +p21/);
    expect(text).not.toContain('p01 ');
    for (const [w, h] of [[20, 6], [12, 4], [40, 9], [6, 3]] as const) {
      for (const p of [moved, press(moved, key('enter')), open('rename', 'cli'), open('split', 'tokengraph', { [OLD]: 'tokengraph', [CLI]: 'tokengraph' })]) {
        const buf = new ScreenBuffer(w + 4, h + 4);
        drawProjectPanel(buf, { x: 2, y: 2, width: w, height: h }, p, tuiTheme('light'));
        const lines = toPlainText(buf).split('\n');
        for (const [y, line] of lines.entries()) {
          if (y < 2 || y >= h + 2) expect(line.trim()).toBe('');
          else expect(line.slice(0, 2) + line.slice(w + 2)).toMatch(/^ *$/);
        }
      }
    }
  });

  it('paints the selected row, the field and the cursor in the theme colours', () => {
    for (const name of ['dark', 'light'] as const) {
      const theme = tuiTheme(name);
      const { buf, text } = draw(open('rename', 'cli'), 80, 20, theme);
      const y = text.split('\n').findIndex((line) => line.includes('cli') && !line.includes('Rename'));
      const x = text.split('\n')[y]!.indexOf('cli') + 3;
      expect(buf.get(x, y)).toMatchObject({ bg: theme.accent });
      expect(buf.get(x + 5, y)).toMatchObject({ bg: theme.panel });
    }
  });
});
