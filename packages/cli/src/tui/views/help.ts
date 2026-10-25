import { ScreenBuffer, type Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { blit } from './props.js';

const KEYS: readonly (readonly [string, string])[] = [
  ['1-4, Tab, click', 'switch tab'],
  ['5', 'setup tab'],
  ['↑ ↓, mouse', 'move day cursor / row selection'],
  ['← →', 'move day cursor by a week (Overview)'],
  ['[  ]', 'previous / next year (Overview)'],
  ['t', 'jump to today'],
  ['←  →, r', 'previous / next range (Models, Agents)'],
  ['←  →, mouse', 'pick an hour (Insights)'],
  ['h', 'manage hooks (Agents)'],
  ['Enter', 'run the selected action (Setup)'],
  ['c', 'per-family / single-hue colour'],
  ['s', 'rescan now'],
  [':  Ctrl-K', 'command palette'],
  ['?', 'toggle this help'],
  ['q, Esc, Ctrl-C', 'quit'],
];
const WORDS: readonly (readonly [string, string])[] = [
  ['weighted tokens', 'input + output + cache writes + 10% of cache reads'],
  ['cache saved', 'what prompt caching saved you vs. full input price'],
  ['est. cost', 'list prices; unpriced models are left out'],
];
const KEY_COLUMN = 18;
const WORDS_COLUMN = 16;
const WORDS_WIDTH = WORDS_COLUMN + 52;
const SCREEN_MARGIN = 2;

/** A centred overlay box listing the key table and, when the screen has room, a glossary; its own cells carry a panel background so it covers the view behind it. */
export function drawHelp(buf: ScreenBuffer, rect: Rect, theme: TuiTheme): void {
  const view = new ScreenBuffer(rect.width, rect.height);
  // Box rows: border, blank, keys, then (blank, heading, words) and the bottom border.
  const keysHeight = KEYS.length + 4;
  const wordsHeight = WORDS.length + 2;
  const withWords = view.height >= keysHeight + wordsHeight + SCREEN_MARGIN && view.width >= WORDS_WIDTH + 2;
  const width = Math.min(view.width, withWords ? WORDS_WIDTH + 2 : KEY_COLUMN + 36);
  const height = Math.min(view.height, withWords ? keysHeight + wordsHeight : keysHeight);
  const box = { x: Math.floor((view.width - width) / 2), y: Math.floor((view.height - height) / 2), width, height };
  view.fill(box, ' ', { bg: theme.panel });
  const inner = drawBox(view, box, theme, 'Keys');
  const room = inner.width - 2;
  KEYS.forEach(([key, action], i) => {
    const y = inner.y + 1 + i;
    if (y >= inner.y + inner.height) return;
    view.text(inner.x + 1, y, key, { fg: theme.accent, bold: true }, Math.min(KEY_COLUMN - 2, room));
    if (room > KEY_COLUMN) view.text(inner.x + 1 + KEY_COLUMN, y, action, { fg: theme.ink }, room - KEY_COLUMN);
  });
  if (withWords) {
    const top = inner.y + 1 + KEYS.length + 1;
    view.text(inner.x + 1, top, 'Words', { fg: theme.muted });
    WORDS.forEach(([term, meaning], i) => {
      const y = top + 1 + i;
      view.text(inner.x + 1, y, term, { fg: theme.accent, bold: true }, Math.min(WORDS_COLUMN - 1, room));
      if (room > WORDS_COLUMN) view.text(inner.x + 1 + WORDS_COLUMN, y, meaning, { fg: theme.ink }, room - WORDS_COLUMN);
    });
  }
  blit(buf, view, rect.x, rect.y);
}
