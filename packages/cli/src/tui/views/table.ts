import { formatTokens } from '@tokengraph/core';
import { mix } from '../color.js';
import { RANGES, RANGE_LABELS, formatCost, type Breakdown, type CostSummary } from '../model.js';
import { ScreenBuffer, type Rect } from '../screen.js';
import { drawBar, drawStackedBar } from '../widgets/bars.js';
import { drawSparkline } from '../widgets/sparkline.js';
import { CHART_MIN_HEIGHT } from './chart.js';
import { shortDate, truncate } from './dates.js';
import { blit, type Hit, type TableState, type ViewProps, type ViewResult } from './props.js';

const CHIP_GAP = 2;
const HEADER_Y = 2;
const FIRST_ROW_Y = 3;
const DETAIL_HEIGHT = 3; // blank line, stacked bar, legend
const FOOTER_HEIGHT = 2; // blank line, footer
const TOKENS_W = 8;
const SHARE_W = 5;
const GAP = 2;
const LAST_W = 11;
const SPARK_W = 30;
const MAX_NAME_W = 28;
const MAX_BAR_W = 30;
const MIN_NAME_W = 10;
const MIN_BAR_W = 8;
const MAX_DETAIL_W = 60;
const TABLE_SHARE = 0.45;
const MIN_TABLE_ROWS = 5;

/** One piece of the footer line, drawn left to right in its own colour. */
export interface FooterPart {
  text: string;
  color: string;
}

/** What a ranked table shows; the models and agents tabs differ only in this. */
export interface TableSpec {
  label: 'MODEL' | 'AGENT';
  rows: readonly Breakdown[];
  /** Swatch, bar and detail colour of a row. */
  color: (row: Breakdown) => string;
  /** Adds the LAST ACTIVE and 30 DAYS columns. */
  extras: boolean;
  /** Muted lines listed after the ranked rows, drawn as given. */
  idle?: readonly string[];
  footer?: readonly FooterPart[];
  /** Draws a chart into the space left under the table and its detail (view-relative rect); the table is capped to leave room for it. */
  chart?: (view: ScreenBuffer, rect: Rect) => void;
}

interface Columns {
  nameX: number;
  nameW: number;
  barX: number;
  barW: number;
  tokensX: number;
  shareX: number;
  costX: number;
  costW: number;
  lastX: number | null;
  sparkX: number | null;
}

/** Splits `width` into columns, two cells apart; the optional ones are dropped (sparkline first) when name and bar would get too narrow. */
function layoutColumns(width: number, longestName: number, extras: boolean, costW: number): Columns {
  const fixed = 2 + 4 * GAP + TOKENS_W + SHARE_W + costW; // swatch, gaps, numeric columns
  const lastW = GAP + LAST_W;
  const sparkW = GAP + SPARK_W;
  const fits = (extra: number) => width - fixed - extra >= MIN_NAME_W + MIN_BAR_W;
  const showLast = extras && fits(lastW);
  const showSpark = showLast && fits(lastW + sparkW);
  const avail = Math.max(0, width - fixed - (showLast ? lastW : 0) - (showSpark ? sparkW : 0));
  const nameW = Math.max(0, Math.min(longestName, MAX_NAME_W, avail - MIN_BAR_W));
  const barW = Math.max(0, Math.min(MAX_BAR_W, avail - nameW));
  const nameX = 2;
  const barX = nameX + nameW + GAP;
  const tokensX = barX + barW + GAP;
  const shareX = tokensX + TOKENS_W + GAP;
  const costX = shareX + SHARE_W + GAP;
  const lastX = showLast ? costX + costW + GAP : null;
  const sparkX = showSpark && lastX !== null ? lastX + LAST_W + GAP : null;
  return { nameX, nameW, barX, barW, tokensX, shareX, costX, costW, lastX, sparkX };
}

/** A row's cost in three widths: full, whole dollars, and `≈ $498+` (the plus stands for models without a known price). */
function costForms(cost: CostSummary): [string, string, string] {
  const full = formatCost(cost);
  if (cost.pricedWeighted === 0) return [full, full, full];
  const dollars = `≈ $${Math.round(cost.dollars).toLocaleString('en-US')}`;
  return cost.unpricedWeighted > 0 ? [full, `${dollars} + unpriced`, `${dollars}+`] : [full, dollars, dollars];
}

function costWidth(rows: readonly Breakdown[], form: number): number {
  return Math.max(4, ...rows.map((r) => [...costForms(r.cost)[form]!].length));
}

function drawChips(view: ScreenBuffer, rect: Rect, props: ViewProps & { state: TableState }, hits: Hit[]): void {
  const { theme, state } = props;
  let x = 0;
  for (const range of RANGES) {
    if (x >= view.width) break;
    const label = RANGE_LABELS[range];
    const active = range === state.range;
    view.text(x, 0, label, { fg: active ? theme.accent : theme.muted, bold: active });
    hits.push({ kind: 'range', range, rect: { x: rect.x + x, y: rect.y, width: Math.min(label.length, view.width - x), height: 1 } });
    x += label.length + CHIP_GAP;
  }
}

function drawHeader(view: ScreenBuffer, cols: Columns, label: string, theme: ViewProps['theme']): void {
  const style = { fg: theme.muted };
  view.text(cols.nameX, HEADER_Y, label, style);
  view.text(cols.barX, HEADER_Y, 'SHARE', style);
  view.text(cols.tokensX + TOKENS_W - 6, HEADER_Y, 'TOKENS', style);
  view.text(cols.costX + cols.costW - 4, HEADER_Y, 'COST', style);
  if (cols.lastX !== null) view.text(cols.lastX, HEADER_Y, 'LAST ACTIVE', style);
  if (cols.sparkX !== null) view.text(cols.sparkX, HEADER_Y, '30 DAYS', style);
}

function drawRow(view: ScreenBuffer, y: number, row: Breakdown, cost: string, i: number, top: number, selected: boolean, cols: Columns, props: ViewProps, color: string): void {
  const { theme, motion } = props;
  if (selected) view.fill({ x: 0, y, width: view.width, height: 1 }, ' ', { bg: theme.panel });
  view.set(0, y, '▀', { fg: color });
  view.text(cols.nameX, y, truncate(row.name, cols.nameW), { fg: theme.ink, bold: selected });
  const fraction = top > 0 ? (row.share / top) * motion.bar(i) : 0;
  drawBar(view, cols.barX, y, cols.barW, fraction, color);
  view.text(cols.tokensX, y, formatTokens(row.weighted).padStart(TOKENS_W), { fg: theme.ink });
  view.text(cols.shareX, y, `${Math.round(row.share * 100)}%`.padStart(SHARE_W), { fg: theme.muted });
  view.text(cols.costX, y, cost.padStart(cols.costW), { fg: theme.muted });
  if (cols.lastX !== null) view.text(cols.lastX, y, shortDate(row.lastActive), { fg: theme.muted });
  if (cols.sparkX !== null) drawSparkline(view, cols.sparkX, y, SPARK_W, row.daily30, color, theme);
}

/** Stacked input / output / cache write / cache read bar of one row, with a legend line below it. */
function drawDetail(view: ScreenBuffer, y: number, row: Breakdown, color: string, theme: ViewProps['theme']): void {
  const parts = [
    { label: 'input', tokens: row.counts.inputTokens, color },
    { label: 'output', tokens: row.counts.outputTokens, color: mix(color, theme.ink, 0.35) },
    { label: 'cache write', tokens: row.counts.cacheCreationTokens, color: mix(color, theme.bg, 0.45) },
    { label: 'cache read', tokens: row.counts.cacheReadTokens, color: mix(color, theme.bg, 0.7) },
  ];
  const width = Math.min(view.width - 2, MAX_DETAIL_W);
  drawStackedBar(view, 2, y, width, parts.map((p) => ({ fraction: p.tokens, color: p.color })));
  let x = 2;
  for (const p of parts) {
    if (x >= view.width) break;
    view.set(x, y + 1, '■', { fg: p.color });
    const text = `${p.label} ${formatTokens(p.tokens)}`;
    view.text(x + 2, y + 1, text, { fg: theme.muted });
    x += 2 + text.length + 2;
  }
}

/** Range chips, the ranked table (scrolled to keep the selected row visible), the selected row's detail and an optional footer. */
export function drawBreakdownTable(buf: ScreenBuffer, rect: Rect, props: ViewProps & { state: TableState }, spec: TableSpec): ViewResult {
  const { theme, state } = props;
  const view = new ScreenBuffer(rect.width, rect.height);
  const hits: Hit[] = [];
  const { rows } = spec;
  drawChips(view, rect, props, hits);

  const longest = Math.max(0, ...rows.map((r) => [...r.name].length), ...(spec.idle ?? []).map((s) => [...s].length));
  // The widest cost form that still leaves room for name, bar and (on agents) LAST ACTIVE; costs are never cut with an ellipsis.
  let form = 0;
  let cols = layoutColumns(view.width, longest, spec.extras, costWidth(rows, form));
  while (form < 2 && (spec.extras ? cols.lastX === null : cols.barW < MIN_BAR_W)) {
    form += 1;
    cols = layoutColumns(view.width, longest, spec.extras, costWidth(rows, form));
  }
  const costs = rows.map((r) => costForms(r.cost)[form]!);
  if (rows.length === 0) {
    view.text(0, HEADER_Y, 'No usage in this range', { fg: theme.muted });
  } else {
    drawHeader(view, cols, spec.label, theme);
  }

  const avail = view.height - FIRST_ROW_Y;
  const wanted = Math.min(rows.length, 3);
  let reserve = 0;
  const showDetail = rows.length > 0 && avail - DETAIL_HEIGHT >= wanted;
  if (showDetail) reserve += DETAIL_HEIGHT;
  const showFooter = !!spec.footer && avail - reserve - FOOTER_HEIGHT >= wanted;
  if (showFooter) reserve += FOOTER_HEIGHT;
  let tableRows = Math.max(0, avail - reserve);
  const bottom = view.height - (showFooter ? FOOTER_HEIGHT : 0);
  // With a chart the table shrinks to make room, unless that would still leave the chart too short to draw.
  let chartCapped = false;
  if (spec.chart && rows.length > 0) {
    const capped = Math.min(tableRows, rows.length + (spec.idle?.length ?? 0), Math.max(MIN_TABLE_ROWS, Math.floor(tableRows * TABLE_SHARE)));
    if (bottom - (FIRST_ROW_Y + capped + (showDetail ? DETAIL_HEIGHT : 0) + 1) >= CHART_MIN_HEIGHT) {
      tableRows = capped;
      chartCapped = true;
    }
  }

  const selected = rows.length === 0 ? 0 : Math.min(Math.max(0, state.selected), rows.length - 1);
  const visible = Math.min(rows.length, tableRows);
  const start = Math.max(0, selected - visible + 1);
  const top = rows.reduce((max, r) => Math.max(max, r.share), 0);
  for (let k = 0; k < visible; k++) {
    const i = start + k;
    const y = FIRST_ROW_Y + k;
    drawRow(view, y, rows[i]!, costs[i]!, i, top, i === selected, cols, props, spec.color(rows[i]!));
    hits.push({ kind: 'row', index: i, rect: { x: rect.x, y: rect.y + y, width: rect.width, height: 1 } });
  }

  let used = visible;
  if (start + visible >= rows.length) {
    for (const line of spec.idle ?? []) {
      if (used >= tableRows) break;
      view.text(cols.nameX, FIRST_ROW_Y + used, line, { fg: theme.muted });
      used++;
    }
  }

  if (form === 2 && rows.some((r) => r.cost.pricedWeighted > 0 && r.cost.unpricedWeighted > 0)) {
    view.text(cols.nameX, FIRST_ROW_Y + used, '+ includes models without a known price', { fg: theme.muted });
  }
  if (showDetail) drawDetail(view, FIRST_ROW_Y + used + 1, rows[selected]!, spec.color(rows[selected]!), theme);
  if (chartCapped) {
    const top = FIRST_ROW_Y + used + (showDetail ? DETAIL_HEIGHT : 0) + 1;
    spec.chart!(view, { x: 0, y: top, width: view.width, height: bottom - top });
  }
  if (showFooter) {
    let x = 0;
    for (const part of spec.footer!) {
      view.text(x, view.height - 1, part.text, { fg: part.color });
      x += [...part.text].length;
    }
  }

  blit(buf, view, rect.x, rect.y);
  return { hits };
}
