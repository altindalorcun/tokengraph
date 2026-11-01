import { formatTokens } from '@tokengraph/core';
import type { ProjectShare, ProjectSummary } from '../../project-usage.js';
import { formatCost, projectSummaries, type Breakdown } from '../model.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import { truncate } from './dates.js';
import type { TableState, ViewProps, ViewResult } from './props.js';
import { drawBreakdownTable } from './table.js';

const NOT_ASSIGNED_NOTE = "Usage with no known project: older logs that are gone, and Cursor's account history.";
const FOOTER = 'Estimated at list prices. This machine only.';
const COLUMN_GAP = 3;
const SPLIT_MIN_HEIGHT = 3; // title and two rows
const TOKENS_W = 7;
const SHARE_W = 7;
const COST_W = 12;

function drawShares(view: ScreenBuffer, area: Rect, title: string, shares: readonly ProjectShare[], theme: TuiTheme): void {
  view.text(area.x, area.y, title, { fg: theme.muted, bold: true });
  const room = area.height - 1;
  // Narrow columns give up the cost before the name, since the table above already shows the project's total.
  const costW = area.width >= 42 ? COST_W : 0;
  const nameW = Math.max(6, area.width - TOKENS_W - SHARE_W - costW - 2);
  shares.slice(0, room).forEach((share, index) => {
    const y = area.y + 1 + index;
    const overflow = index === room - 1 && shares.length > room;
    view.text(area.x, y, overflow ? `+ ${shares.length - index} more` : truncate(share.name, nameW), { fg: overflow ? theme.muted : theme.ink }, nameW);
    if (overflow) return;
    let x = area.x + nameW + 1;
    view.text(x, y, formatTokens(share.weighted).padStart(TOKENS_W), { fg: theme.ink });
    x += TOKENS_W;
    view.text(x, y, `${(share.share * 100).toFixed(1)}%`.padStart(SHARE_W), { fg: theme.muted });
    x += SHARE_W + 1;
    if (costW > 0) view.text(x, y, formatCost(share.cost).padStart(costW), { fg: theme.muted }, costW);
  });
}

const isAssigned = (row: Breakdown): boolean => (row as ProjectSummary).assigned;

/** The selected project's models beside its agents. */
function drawSplit(view: ScreenBuffer, area: Rect, project: ProjectSummary, theme: TuiTheme): void {
  const width = Math.floor((area.width - COLUMN_GAP) / 2);
  drawShares(view, { ...area, width }, 'MODELS', project.models, theme);
  drawShares(view, { ...area, x: area.x + width + COLUMN_GAP, width }, 'AGENTS', project.agents, theme);
}

/** Projects ranked by weighted tokens, Not assigned last, with the selected one's models and agents under the table. */
export function drawProjects(buf: ScreenBuffer, rect: Rect, props: ViewProps & { state: TableState }): ViewResult {
  const { vm, theme, state } = props;
  const rows = projectSummaries(vm, state.range);
  const selected = rows[Math.min(Math.max(0, state.selected), rows.length - 1)];
  return drawBreakdownTable(buf, rect, props, {
    label: 'PROJECT',
    rows,
    color: (row) => (isAssigned(row) ? theme.accent : theme.muted),
    extras: true,
    footnote: (row) => {
      if (!isAssigned(row)) return NOT_ASSIGNED_NOTE;
      const { length } = (row as ProjectSummary).folders;
      return length > 1 ? `${length} folders` : null;
    },
    footer: [{ text: FOOTER, color: theme.muted }],
    chartMinHeight: SPLIT_MIN_HEIGHT,
    chart: (view, area) => {
      if (selected) drawSplit(view, area, selected, theme);
    },
  });
}
