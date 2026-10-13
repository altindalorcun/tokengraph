import { formatTokens } from '@tokengraph/core';
import type { DayRow } from '../model.js';
import { formatCost } from '../model.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import { familyColor, type TuiTheme } from '../theme.js';
import { drawBar } from './bars.js';
import { drawBox } from './box.js';

export interface DayPanelProps {
  day: DayRow | null;
  date: string;
  theme: TuiTheme;
}

export const DAY_PANEL_WIDTH = 34;

const NAME_WIDTH = 16;
const TOKENS_WIDTH = 6;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-30" -> "Wed 30 Sep 2026" (UTC); anything unparseable is returned as is. */
function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width <= 0 ? '' : `${chars.slice(0, width - 1).join('')}…`;
}

/** A boxed panel for one day: date title, weighted + cost line, model rows with bars, agent split line. */
export function drawDayPanel(buf: ScreenBuffer, rect: Rect, props: DayPanelProps): void {
  const { day, date, theme } = props;
  const inner = drawBox(buf, rect, theme);
  if (rect.width < 4 || rect.height < 2) return;
  // drawBox upper-cases its title; a date reads better in its natural case.
  buf.text(rect.x + 2, rect.y, ` ${formatDate(date)} `, { fg: theme.muted, bold: true }, rect.width - 4);
  if (inner.height < 1 || inner.width < 3) return;

  const left = inner.x + 1; // one column of padding inside the border
  const room = inner.width - 2;
  if (!day || day.weighted <= 0) {
    buf.text(left, inner.y, 'No tokens this day', { fg: theme.muted }, room);
    return;
  }

  const weighted = `${formatTokens(day.weighted)} weighted`;
  const used = buf.text(left, inner.y, weighted, { fg: theme.ink, bold: true }, room);
  const cost = formatCost(day.cost);
  if (used + 1 + cost.length <= room) buf.text(left + room - cost.length, inner.y, cost, { fg: theme.muted }, cost.length);

  // Line 0 is the totals, then a blank line, the model rows, a blank line and the agent split.
  const modelRows = Math.min(Math.max(0, rect.height - 6), day.models.length);
  const barWidth = room - NAME_WIDTH - TOKENS_WIDTH - 2;
  for (let i = 0; i < modelRows; i++) {
    const model = day.models[i]!;
    const y = inner.y + 2 + i;
    const tokens = formatTokens(model.weighted);
    // Every piece is clipped to the inner room; on a narrow rect the tokens and bar give way to the name.
    const tokensFit = room - tokens.length - 1 >= 1;
    const nameWidth = Math.min(NAME_WIDTH, tokensFit ? room - tokens.length - 1 : room);
    buf.text(left, y, truncate(model.name, nameWidth), { fg: theme.ink }, nameWidth);
    if (barWidth >= 1) drawBar(buf, left + NAME_WIDTH + 1, y, barWidth, model.weighted / day.weighted, familyColor(model.family, theme));
    if (tokensFit) buf.text(left + room - tokens.length, y, tokens, { fg: theme.muted }, tokens.length);
  }

  if (inner.height >= 3) {
    const agents = day.agents.map((a) => `${a.name} ${Math.round((a.weighted / day.weighted) * 100)}%`).join(' · ');
    buf.text(left, inner.y + inner.height - 1, truncate(agents, room), { fg: theme.muted }, room);
  }
}
