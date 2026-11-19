import { describe, expect, it } from 'vitest';
import { emptyLedger } from '../../src/ledger.js';
import { qrMatrix } from '../../src/share/qr.js';
import { STILL } from '../../src/tui/animate.js';
import { initialState, reduce, renderFrame, requestAction } from '../../src/tui/app.js';
import type { AppState } from '../../src/tui/app-state.js';
import { buildViewModel } from '../../src/tui/model.js';
import { toPlainText } from '../../src/tui/screen.js';
import { applyStoryEvent, canSave, openStoryPanel, storyKey, type StoryPanel } from '../../src/tui/story-panel.js';
import type { StoryEvent } from '../../src/tui/story-session.js';

const URL = 'http://192.168.1.20:50123/AbCdEfGhIjKlMnOpQrStUv/';
const key = (name: 'up' | 'down' | 'enter' | 'escape') => ({ type: 'key', key: name }) as const;
const char = (c: string) => ({ type: 'char', char: c }) as const;

function apply(panel: StoryPanel, ...events: StoryEvent[]): StoryPanel {
  return events.reduce(applyStoryEvent, panel);
}

/** A box past the period question, with every card drawn. */
function drawn(): StoryPanel {
  const picked = storyKey(openStoryPanel(), key('enter')).panel;
  return apply(
    picked,
    { kind: 'loaded', handle: 'octocat', empty: false },
    { kind: 'drawing', id: 'skyline' }, { kind: 'drawn', id: 'skyline' },
    { kind: 'drawing', id: 'receipt' }, { kind: 'drawn', id: 'receipt' },
    { kind: 'drawing', id: 'sticker' }, { kind: 'drawn', id: 'sticker' },
  );
}

describe('storyKey', () => {
  it('moves through the periods without wrapping and starts the chosen one on Enter', () => {
    let panel = openStoryPanel();
    expect(panel.step).toBe('range');
    panel = storyKey(panel, key('up')).panel;
    expect(panel.selected).toBe(0);
    for (let i = 0; i < 6; i += 1) panel = storyKey(panel, key('down')).panel;
    expect(panel.selected).toBe(3);
    panel = storyKey(panel, key('up')).panel;
    const out = storyKey(panel, key('enter'));
    expect(out.command).toEqual({ story: 'start', range: '30d' });
    expect(out.panel).toMatchObject({ step: 'drawing', range: '30d' });
  });

  it('closes on Esc and Ctrl-C from every step, and ignores other keys', () => {
    for (const panel of [openStoryPanel(), storyKey(openStoryPanel(), key('enter')).panel, drawn()]) {
      expect(storyKey(panel, key('escape')).command).toEqual({ story: 'close' });
      expect(storyKey(panel, { type: 'ctrl', char: 'c' }).command).toEqual({ story: 'close' });
      for (const event of [char('q'), char('2'), { type: 'key', key: 'tab' } as const, { type: 'mouse', action: 'press', x: 1, y: 1, button: 0 } as const]) {
        expect(storyKey(panel, event)).toEqual({ panel, command: null });
      }
    }
  });

  it('saves on s once the cards are drawn, not while saving or after, and again after a failure', () => {
    const drawing = storyKey(openStoryPanel(), key('enter')).panel;
    expect(storyKey(drawing, char('s')).command).toBeNull();
    const ready = drawn();
    const saving = storyKey(ready, char('S'));
    expect(saving.command).toEqual({ story: 'save' });
    expect(saving.panel.save).toEqual({ state: 'saving' });
    expect(storyKey(saving.panel, char('s')).command).toBeNull();
    expect(canSave(apply(ready, { kind: 'saved', dir: '/d' }))).toBe(false);
    expect(storyKey(apply(ready, { kind: 'save-failed', reason: 'no' }), char('s')).command).toEqual({ story: 'save' });
  });
});

describe('applyStoryEvent', () => {
  it('follows the cards as they are drawn and only then is ready', () => {
    const picked = storyKey(openStoryPanel(), key('enter')).panel;
    const half = apply(picked, { kind: 'drawing', id: 'skyline' }, { kind: 'drawn', id: 'skyline' }, { kind: 'drawing', id: 'receipt' });
    expect(half.step).toBe('drawing');
    expect(half.cards.map((c) => c.status)).toEqual(['ready', 'drawing', 'waiting']);
    expect(drawn().step).toBe('ready');
  });

  it('tracks the share, the phone and its downloads', () => {
    const qr = qrMatrix(URL);
    const live = apply(drawn(), { kind: 'sharing', url: URL, qr }, { kind: 'phone' }, { kind: 'downloaded', id: 'receipt' });
    expect(live.share).toEqual({ state: 'live', url: URL, qr, phone: true });
    expect(live.cards.find((c) => c.id === 'receipt')!.status).toBe('downloaded');
    expect(apply(live, { kind: 'stopped', reason: 'idle' }).share).toEqual({ state: 'stopped', reason: 'idle', url: URL });
  });

  it('keeps drawn cards saveable when sharing fails, but not when drawing fails', () => {
    const offline = apply(drawn(), { kind: 'offline' });
    expect(offline.share.state).toBe('offline');
    expect(canSave(offline)).toBe(true);
    const busy = apply(drawn(), { kind: 'failed', reason: 'Could not start sharing: EADDRINUSE', saveable: true });
    expect(busy.share).toEqual({ state: 'failed', reason: 'Could not start sharing: EADDRINUSE' });
    expect(canSave(busy)).toBe(true);
    const broken = apply(storyKey(openStoryPanel(), key('enter')).panel, { kind: 'failed', reason: 'Could not draw the cards: x', saveable: false });
    expect(broken).toMatchObject({ step: 'failed', error: 'Could not draw the cards: x' });
    expect(canSave(broken)).toBe(false);
  });
});

describe('the story box in the app', () => {
  const TODAY = '2026-11-13';
  const base = (): AppState => ({ ...initialState(buildViewModel(emptyLedger(), TODAY), 'local only'), tab: 'setup' });
  const text = (state: AppState, width = 100, height = 34) => toPlainText(renderFrame(state, { theme: 'dark' }, width, height, STILL).buffer);

  it('opens from the action, holds the run so scans wait, and takes every key until Esc', () => {
    const opened = requestAction(base(), 'story');
    expect(opened.effects).toEqual([]);
    expect(opened.state.running).toBe('story');
    expect(opened.state.story?.step).toBe('range');
    // q and the tab keys belong to the box now.
    expect(reduce(opened.state, char('q'), null)).toEqual({ state: opened.state, effects: [] });
    expect(reduce(opened.state, char('1'), null).state.tab).toBe('setup');
    const started = reduce(opened.state, key('enter'), null);
    expect(started.effects).toEqual([{ story: 'start', range: 'today' }]);
    const closed = reduce(started.state, key('escape'), null);
    expect(closed.effects).toEqual([{ story: 'close' }]);
    expect(closed.state).toMatchObject({ story: null, running: null, tab: 'setup' });
  });

  it('draws the period question, then the QR code beside the cards with the keys under them', () => {
    const asking = requestAction(base(), 'story').state;
    const question = text(asking);
    expect(question).toContain('STORY CARDS');
    expect(question).toContain('Which period should the cards cover?');
    expect(question).toContain('▸ Today');
    expect(question).toContain('Last 12 months');
    expect(question).toContain('enter make cards');
    expect(question).not.toContain('q quit'); // the view's keys are hidden while the box is open

    const live = apply(drawn(), { kind: 'sharing', url: URL, qr: qrMatrix(URL) }, { kind: 'phone' }, { kind: 'downloaded', id: 'skyline' });
    const sharing = text({ ...asking, story: live });
    expect(sharing).toContain("Scan with your phone's camera");
    // The address is shown whole, over two rows, never shortened.
    expect(sharing).toContain('http://192.168.1.20:50123/AbCdEfGhIjKl');
    expect(sharing).toContain('MnOpQrStUv/');
    expect(sharing.split('\n').filter((line) => line.includes('http')).join('')).not.toContain('…');
    expect(sharing).toContain('Today  @octocat');
    expect(sharing).toContain('✓ Skyline  on your phone');
    expect(sharing).toContain('● Phone connected');
    expect(sharing).toContain('s save to this computer  esc close');
    expect(sharing).toContain('▄');

    // The code is black on white whatever the theme.
    const { buffer } = renderFrame({ ...asking, story: live }, { theme: 'dark' }, 100, 34, STILL);
    const colours = new Set<string | null>();
    for (let y = 3; y < buffer.height; y += 1) for (let x = 0; x < buffer.width; x += 1) {
      const cell = buffer.get(x, y)!;
      if (cell.ch === '▄') colours.add(cell.fg).add(cell.bg);
    }
    expect([...colours].sort()).toEqual(['#000000', '#ffffff']);
  });

  it('asks for a bigger window instead of drawing a QR code that does not fit, and gives the address', () => {
    const live = apply(drawn(), { kind: 'sharing', url: URL, qr: qrMatrix(URL) });
    const cramped = text({ ...requestAction(base(), 'story').state, story: live }, 80, 24);
    expect(cramped).toContain("Scan with your phone's camera");
    const narrow = text({ ...requestAction(base(), 'story').state, story: { ...live, share: { ...live.share, qr: qrMatrix(`${URL}${'x'.repeat(60)}`) } as StoryPanel['share'] } }, 80, 24);
    expect(narrow).toContain('Make the window at least');
    expect(narrow).toContain('Or open this address on your phone:');
    expect(narrow).toContain('http://192.168.1.20:50123/AbCdEfGhIjKlMnOp');
    expect(narrow).not.toContain('▄▄');
  });

  it('says why sharing stopped and where the cards were saved', () => {
    const state = requestAction(base(), 'story').state;
    const offline = text({ ...state, story: apply(drawn(), { kind: 'offline' }) });
    expect(offline).toContain('No Wi-Fi or Ethernet network found');
    expect(offline).toContain('s save to this computer');
    const done = text({ ...state, story: apply(drawn(), { kind: 'stopped', reason: 'idle' }, { kind: 'saved', dir: '/Users/me/Downloads' }) });
    expect(done).toContain('No activity for 10 minutes. Stopped sharing.');
    expect(done).toContain('✓ Saved to /Users/me/Downloads');
    // A folder wider than the box is shown whole over several rows, never shortened.
    const dir = `/Users/me/${'very-long-folder-name/'.repeat(4)}Downloads`;
    const rows = text({ ...state, story: apply(drawn(), { kind: 'saved', dir }) }).split('\n');
    const from = rows.findIndex((row) => row.includes('✓ Saved to'));
    const shown: string[] = [];
    for (const row of rows.slice(from)) {
      const inside = row.split('│')[1]?.trim() ?? '';
      if (inside === '') break;
      shown.push(inside);
    }
    expect(shown.join('').replace(/\s/g, '')).toBe(`✓Savedto${dir}`);
    expect(done).not.toContain('s save');
    const empty = text({ ...state, story: apply(drawn(), { kind: 'loaded', handle: 'octocat', empty: true }) });
    expect(empty).toContain('No usage in this period yet');
  });
});
