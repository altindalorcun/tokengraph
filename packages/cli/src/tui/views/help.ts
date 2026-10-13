import { ScreenBuffer, type Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { blit } from './props.js';

const KEYS: readonly (readonly [string, string])[] = [
  ['1-4, Tab, click', 'switch tab'],
  ['↑ ↓, mouse', 'move day cursor / row selection'],
  ['← →', 'move day cursor by a week (Overview)'],
  ['[  ]', 'previous / next year (Overview)'],
  ['t', 'jump to today'],
  ['←  →, r', 'previous / next range (Models, Agents)'],
  ['c', 'per-family / single-hue colour'],
  ['s', 'rescan now'],
  ['?', 'toggle this help'],
  ['q, Esc, Ctrl-C', 'quit'],
];
const KEY_COLUMN = 18;

/** A centred overlay box listing the key table; its own cells carry a panel background so it covers the view behind it. */
export function drawHelp(buf: ScreenBuffer, rect: Rect, theme: TuiTheme): void {
  const view = new ScreenBuffer(rect.width, rect.height);
  const width = Math.min(view.width, KEY_COLUMN + 36);
  const height = Math.min(view.height, KEYS.length + 4);
  const box = { x: Math.floor((view.width - width) / 2), y: Math.floor((view.height - height) / 2), width, height };
  view.fill(box, ' ', { bg: theme.panel });
  const inner = drawBox(view, box, theme, 'Keys');
  KEYS.forEach(([key, action], i) => {
    const y = inner.y + 1 + i;
    if (y >= inner.y + inner.height) return;
    const room = inner.width - 2;
    view.text(inner.x + 1, y, key, { fg: theme.accent, bold: true }, Math.min(KEY_COLUMN - 2, room));
    if (room > KEY_COLUMN) view.text(inner.x + 1 + KEY_COLUMN, y, action, { fg: theme.ink }, room - KEY_COLUMN);
  });
  blit(buf, view, rect.x, rect.y);
}
