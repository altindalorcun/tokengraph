import { ScreenBuffer, type Rect } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { blit } from './props.js';

export const MIN_WIDTH = 80;
export const MIN_HEIGHT = 24;

/** Centred "Make the window at least 80×24 (now W×H)", clipped to the rect. */
export function drawTooSmall(buf: ScreenBuffer, rect: Rect, theme: TuiTheme): void {
  const view = new ScreenBuffer(rect.width, rect.height);
  const text = `Make the window at least ${MIN_WIDTH}×${MIN_HEIGHT} (now ${rect.width}×${rect.height})`;
  const chars = [...text];
  const shown = chars.length > view.width ? chars.slice(0, view.width).join('') : text;
  const x = Math.max(0, Math.floor((view.width - chars.length) / 2));
  view.text(x, Math.floor((view.height - 1) / 2), shown, { fg: theme.ink, bold: true });
  blit(buf, view, rect.x, rect.y);
}
