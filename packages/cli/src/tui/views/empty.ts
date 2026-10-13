import { searchedPaths } from '../../collect-local.js';
import { ScreenBuffer, type Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { drawFlame } from '../widgets/logo.js';
import { blit } from './props.js';

const FLAME_WIDTH = 8;
const FLAME_HEIGHT = 6;

/** The centred "nothing found" card: flame, title, the places that were searched and the Cursor hint. */
export function drawEmpty(buf: ScreenBuffer, rect: Rect, props: { theme: TuiTheme; scanning: boolean }): void {
  const { theme, scanning } = props;
  const view = new ScreenBuffer(rect.width, rect.height);
  const lines: { text: string; style: { fg: string; bold?: boolean } }[] = [
    { text: scanning ? 'Looking for AI coding usage…' : 'No AI coding usage found yet', style: { fg: theme.ink, bold: true } },
    { text: '', style: { fg: theme.muted } },
    ...searchedPaths().map((text) => ({ text, style: { fg: theme.muted } })),
    { text: '', style: { fg: theme.muted } },
    { text: 'Cursor needs a hook: tokengraph install-hook --agent cursor', style: { fg: theme.muted } },
    { text: '', style: { fg: theme.muted } },
    { text: 'Press q to quit', style: { fg: theme.muted } },
  ];
  const total = FLAME_HEIGHT + 1 + lines.length;
  const top = Math.max(0, Math.floor((view.height - total) / 2));
  drawFlame(view, Math.floor((view.width - FLAME_WIDTH) / 2), top, theme.bg);
  lines.forEach((line, i) => {
    const length = [...line.text].length;
    view.text(Math.max(0, Math.floor((view.width - length) / 2)), top + FLAME_HEIGHT + 1 + i, line.text, line.style, view.width);
  });
  blit(buf, view, rect.x, rect.y);
}
