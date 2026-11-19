import { CLAUDE_CODE_SOURCE, type LimitView, type LimitWindowView } from '@tokengraph/core';
import { ageText, durationText, limitName, noClaudeReadingText } from '../../commands/limits.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import type { Hit, ViewProps, ViewResult } from './props.js';

/** The plan limit readings under the Overview heatmap: one row per limit window, as the agents reported them. */

const BAR_WIDTH = 14;
const PCT_WIDTH = 4;
const GAP = 2;

export interface LimitsBlock {
  views: readonly LimitView[];
  /** Whether Claude Code's status line goes through tokengraph; null when unknown. */
  wrapperOn: boolean | null;
}

const hasClaude = (views: readonly LimitView[]): boolean => views.some((view) => view.source === CLAUDE_CODE_SOURCE);

/** 0 when there is nothing to say; else the title, one row per window and one for a missing Claude Code reading. */
export function limitsBlockHeight(views: readonly LimitView[], wrapperOn: boolean | null): number {
  if (views.length === 0 && wrapperOn === null) return 0;
  return 1 + views.reduce((sum, view) => sum + view.windows.length, 0) + (hasClaude(views) ? 0 : 1);
}

function levelColor(window: LimitWindowView, theme: TuiTheme): string {
  return window.level === 'bad' ? theme.bad : window.level === 'warn' ? theme.warn : theme.good;
}

/** Which optional columns fit `width`: the age goes first, then the reset time, then the bar. */
function columns(width: number, fixed: number, resetWidth: number, ageWidth: number): { bar: boolean; reset: boolean; age: boolean } {
  const bar = BAR_WIDTH + 1;
  const reset = resetWidth > 0 ? GAP + resetWidth : 0;
  const age = ageWidth > 0 ? GAP + ageWidth : 0;
  if (fixed + bar + reset + age <= width) return { bar: true, reset: true, age: true };
  if (fixed + bar + reset <= width) return { bar: true, reset: true, age: false };
  if (fixed + bar <= width) return { bar: true, reset: false, age: false };
  return { bar: false, reset: false, age: false };
}

export function drawLimits(buf: ScreenBuffer, rect: Rect, props: ViewProps & LimitsBlock): ViewResult {
  const { theme, views, wrapperOn } = props;
  const hits: Hit[] = [];
  if (limitsBlockHeight(views, wrapperOn) === 0 || rect.height <= 0) return { hits };
  const right = rect.x + rect.width;
  const room = (x: number) => Math.max(0, right - x);
  buf.text(rect.x, rect.y, 'LIMITS', { fg: theme.muted }, rect.width);

  const names = [...(hasClaude(views) ? [] : ['Claude Code']), ...views.map(limitName)];
  const nameWidth = Math.max(...names.map((name) => [...name].length)) + GAP;
  const windows = views.flatMap((view) => view.windows);
  const labelWidth = Math.max(0, ...windows.map((w) => w.label.length)) + GAP;
  const resetTexts = windows.map((w) => (w.reset ? '' : `resets in ${durationText(w.resetsInMs)}`));
  const ageTexts = views.map((view) => ageText(view.ageMs));
  const fit = columns(rect.width, nameWidth + labelWidth + PCT_WIDTH, Math.max(0, ...resetTexts.map((t) => t.length)), Math.max(0, ...ageTexts.map((t) => t.length + 2)));

  let y = rect.y + 1;
  const bottom = rect.y + rect.height;
  if (!hasClaude(views) && y < bottom) {
    buf.text(rect.x, y, 'Claude Code', { fg: theme.ink }, rect.width);
    const text = noClaudeReadingText(wrapperOn, 'turn on in Setup');
    buf.text(rect.x + nameWidth, y, text, { fg: theme.muted }, room(rect.x + nameWidth));
    if (wrapperOn !== true) hits.push({ kind: 'action', id: 'claude-limits', rect: { x: rect.x, y, width: Math.min(rect.width, nameWidth + text.length), height: 1 } });
    y += 1;
  }
  for (const [viewIndex, view] of views.entries()) {
    for (const [index, window] of view.windows.entries()) {
      if (y >= bottom) return { hits };
      if (index === 0) buf.text(rect.x, y, limitName(view), { fg: theme.ink }, nameWidth - 1);
      let x = rect.x + nameWidth;
      buf.text(x, y, window.label, { fg: theme.muted }, room(x));
      x += labelWidth;
      if (window.reset) {
        x += buf.text(x, y, 'reset · no reading since', { fg: theme.muted }, room(x));
      } else {
        const color = levelColor(window, theme);
        const pct = window.usedPercent!;
        if (fit.bar) {
          const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((pct / 100) * BAR_WIDTH)));
          for (let i = 0; i < BAR_WIDTH; i += 1) buf.set(x + i, y, i < filled ? '█' : '░', { fg: i < filled ? color : theme.faint });
          x += BAR_WIDTH + 1;
        }
        // The share is always printed, so colour is never the only channel.
        x += buf.text(x, y, `${Math.round(pct)}%`.padStart(PCT_WIDTH), { fg: theme.ink }, room(x));
        if (fit.reset) x += buf.text(x + GAP, y, `resets in ${durationText(window.resetsInMs)}`, { fg: theme.muted }, room(x + GAP)) + GAP;
      }
      if (index === 0 && fit.age) {
        const ageX = rect.x + nameWidth + labelWidth + PCT_WIDTH + (fit.bar ? BAR_WIDTH + 1 : 0) + (fit.reset ? GAP + Math.max(0, ...resetTexts.map((t) => t.length)) : 0);
        buf.text(Math.max(x, ageX) + GAP, y, `· ${ageTexts[viewIndex]}`, { fg: theme.faint }, room(Math.max(x, ageX) + GAP));
      }
      y += 1;
    }
  }
  return { hits };
}
