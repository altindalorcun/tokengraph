import { formatTokens } from '@tokengraph/core';
import {
  dailySeries,
  familySeries,
  modelBreakdown,
  rangeTotals,
  shiftDate,
  stats,
  yearGrid,
  type RangeTotals,
  type Stats,
} from '../model.js';
import { ScreenBuffer, type Rect } from '../screen.js';
import { familyColor, type TuiTheme } from '../theme.js';
import { drawBox } from '../widgets/box.js';
import { bigTextWidth, drawBigText } from '../widgets/big-digits.js';
import { DAY_PANEL_WIDTH, drawDayPanel } from '../widgets/day-panel.js';
import { HEATMAP_FULL_WIDTH, HEATMAP_HEIGHT, HEATMAP_LARGE_WIDTH, drawHeatmap } from '../widgets/heatmap.js';
import { drawSparkline } from '../widgets/sparkline.js';
import { drawStackedColumns } from '../widgets/stacked-columns.js';
import { drawTiles, type Tile } from '../widgets/tiles.js';
import { shortDate, truncate } from './dates.js';
import { blit, type OverviewState, type ViewProps, type ViewResult } from './props.js';

const TILE_HEIGHT = 3;
const BIG_TILE_HEIGHT = 5;
const BIG_LAYOUT_MIN_HEIGHT = 28;
const MIN_TILE_WIDTH = 14; // keep in step with drawTiles
const SERIES_DAYS = 30;
const CHART_MIN_HEIGHT = 6;
const CHART_PANEL_MIN_WIDTH = 100;
const DAY_PANEL_MAX_HEIGHT = 12;
const MIN_PANEL_HEIGHT = 7; // date, summary, blank, one model row, ..., border
const LARGE_OVERVIEW_WIDTH = 140;

interface BigTile {
  title: string;
  value: string;
  detail?: string;
  shortDetail?: string;
  detailColor?: string;
}

function dollarsText(month: RangeTotals): string {
  const { dollars, pricedWeighted, unpricedWeighted } = month.cost;
  if (pricedWeighted === 0 && unpricedWeighted > 0) return '—';
  if (dollars >= 100) return `$${Math.round(dollars).toLocaleString('en-US')}`;
  return `$${dollars.toFixed(2)}`;
}

/** Plain-tile cost value: whole dollars from $100, and `+ unpriced` lives in the detail instead. */
function plainCost(month: RangeTotals): string {
  const { dollars, pricedWeighted, unpricedWeighted } = month.cost;
  if (pricedWeighted === 0) return unpricedWeighted > 0 ? 'cost unknown' : '$0.00';
  return `≈ ${dollars >= 100 ? `$${Math.round(dollars).toLocaleString('en-US')}` : `$${dollars.toFixed(2)}`}`;
}

function plainCostDetail(month: RangeTotals): string {
  return `30d${month.cost.pricedWeighted > 0 && month.cost.unpricedWeighted > 0 ? ' + unpriced' : ''}`;
}

function bigTiles(s: Stats, month: RangeTotals, today: string, week: string, theme: TuiTheme): BigTile[] {
  const delta = s.weekDelta === null ? null : Math.round(Math.abs(s.weekDelta) * 100);
  const up = s.weekDelta !== null && s.weekDelta >= 0;
  const unpriced = month.cost.pricedWeighted > 0 && month.cost.unpricedWeighted > 0;
  return [
    { title: 'Today', value: today, detail: delta === null ? undefined : `${up ? '▲' : '▼'} ${delta}%`, detailColor: up ? theme.good : theme.bad },
    { title: 'This week', value: week },
    { title: 'Streak', value: `${s.streak}d`, detail: `best ${s.longest?.length ?? 0}` },
    { title: 'Est. cost', value: dollarsText(month), detail: `30d${unpriced ? ' · +unpriced' : ''}`, shortDetail: '30d' },
    { title: 'Cache hit', value: month.cacheHit === null ? '—' : `${Math.round(month.cacheHit * 100)}%` },
  ];
}

/** Five boxed tiles with seven-segment values (3 inner rows); the detail sits right-aligned on the top row. */
function drawBigTiles(view: ScreenBuffer, width: number, tiles: readonly BigTile[], theme: TuiTheme): void {
  const base = Math.floor(width / tiles.length);
  const extra = width - base * tiles.length;
  let x = 0;
  tiles.forEach((tile, i) => {
    const tileWidth = base + (i < extra ? 1 : 0);
    const inner = drawBox(view, { x, y: 0, width: tileWidth, height: BIG_TILE_HEIGHT }, theme, tile.title);
    const left = inner.x + 1;
    const room = inner.width - 2;
    x += tileWidth;
    if (room <= 0) return;
    let used: number;
    if (tile.value === '—' || bigTextWidth(tile.value) > room) {
      used = view.text(left, inner.y + 1, tile.value, { fg: theme.ink, bold: true }, room);
    } else {
      drawBigText(view, left, inner.y, tile.value, theme.ink, theme.accent);
      used = bigTextWidth(tile.value);
    }
    // Whole or not at all: the short form, else nothing.
    const available = room - used - 1;
    const text = [tile.detail, tile.shortDetail].find((d) => d !== undefined && [...d].length <= available);
    if (text) view.text(left + room - [...text].length, inner.y, text, { fg: tile.detailColor ?? theme.muted, bold: false });
  });
}

/** Whether every big value fits its tile; judged on the settled numbers so the layout never flips mid-animation. */
function bigTilesFit(width: number, tiles: readonly BigTile[]): boolean {
  const base = Math.floor(width / tiles.length);
  if (base < MIN_TILE_WIDTH) return false;
  const extra = width - base * tiles.length;
  return tiles.every((tile, i) => tile.value === '—' || bigTextWidth(tile.value) + 2 <= base + (i < extra ? 1 : 0) - 2);
}

/** The LAST 30 DAYS box: one stacked column per day, coloured by model family. */
function drawChart(view: ScreenBuffer, rect: Rect, props: ViewProps & { state: OverviewState }): void {
  const { vm, theme, state } = props;
  const inner = drawBox(view, rect, theme, 'Last 30 days');
  const colsWidth = inner.width - 2;
  const colsHeight = inner.height - 2; // a label row above, a date row below
  if (colsWidth < 1 || colsHeight < 1) return;
  const x0 = inner.x + 1;

  let gap = 1;
  let width = Math.floor((colsWidth + gap) / SERIES_DAYS) - gap;
  if (width < 1) {
    gap = 0;
    width = Math.max(1, Math.floor(colsWidth / SERIES_DAYS));
  }
  const stride = width + gap;
  const count = Math.min(SERIES_DAYS, Math.floor((colsWidth + gap) / stride));
  if (count < 1) return;
  const series = familySeries(vm, vm.today, SERIES_DAYS).slice(SERIES_DAYS - count);

  // Centred, so spare columns do not pile up on the right.
  const used = count * stride - gap;
  const cx = x0 + Math.floor((colsWidth - used) / 2);
  const peak = Math.max(...series.map((d) => d.families.reduce((sum, f) => sum + f.weighted, 0)));
  if (peak > 0) view.text(x0, inner.y, `max ${formatTokens(peak)}`, { fg: theme.muted }, colsWidth);
  drawStackedColumns(
    view,
    { x: cx, y: inner.y + 1, width: used, height: colsHeight },
    series.map((d) => ({
      segments: d.families.map((f) => ({ value: f.weighted, color: familyColor(f.family, theme) })),
      highlight: d.date === state.cursor,
    })),
    { width, gap, emptyColor: theme.faint, highlightColor: theme.ink },
  );

  const dateY = inner.y + inner.height - 1;
  const first = shortDate(series[0]!.date);
  view.text(cx, dateY, first, { fg: theme.muted }, used);
  const todayLabel = 'today';
  const todayX = cx + used - todayLabel.length;
  if (todayX > cx + first.length) view.text(todayX, dateY, todayLabel, { fg: theme.muted });
  const mid = shortDate(series[Math.floor(count / 2)]!.date);
  const midX = cx + Math.floor(count / 2) * stride;
  if (midX > cx + first.length + 1 && midX + mid.length < todayX - 1) view.text(midX, dateY, mid, { fg: theme.muted });
}

/** TOP MODELS · 30D: swatch, name and weighted tokens per model. */
function drawTopModels(view: ScreenBuffer, rect: Rect, props: ViewProps): void {
  const { vm, theme } = props;
  const inner = drawBox(view, rect, theme, 'Top models · 30d');
  const room = inner.width - 2;
  if (room < 6) return;
  modelBreakdown(vm, '30d').slice(0, Math.max(0, inner.height)).forEach((model, i) => {
    const y = inner.y + i;
    const tokens = formatTokens(model.weighted);
    view.set(inner.x + 1, y, '■', { fg: familyColor(model.family, theme) });
    const nameRoom = room - 2 - tokens.length - 1;
    if (nameRoom > 0) view.text(inner.x + 3, y, truncate(model.name, nameRoom), { fg: theme.ink }, nameRoom);
    view.text(inner.x + 1 + room - tokens.length, y, tokens, { fg: theme.muted });
  });
}

/** Tiles, the year heatmap, then the 30-day stacked chart with the day panel and top models, clipped to `rect`. */
export function drawOverview(buf: ScreenBuffer, rect: Rect, props: ViewProps & { state: OverviewState }): ViewResult {
  const { vm, theme, motion, colorMode, state } = props;
  const view = new ScreenBuffer(rect.width, rect.height);
  const s = stats(vm);
  const month = rangeTotals(vm, '30d');

  const settled = bigTiles(s, month, formatTokens(s.today), formatTokens(s.week), theme);
  const big = view.height >= BIG_LAYOUT_MIN_HEIGHT && bigTilesFit(view.width, settled);
  const tileHeight = big ? BIG_TILE_HEIGHT : TILE_HEIGHT;
  if (big) {
    drawBigTiles(view, view.width, bigTiles(s, month, formatTokens(motion.number('today', s.today)), formatTokens(motion.number('week', s.week)), theme), theme);
  } else {
    const delta = s.weekDelta === null ? null : Math.round(Math.abs(s.weekDelta) * 100);
    const up = s.weekDelta !== null && s.weekDelta >= 0;
    const tiles: Tile[] = [
      { title: 'Today', value: formatTokens(motion.number('today', s.today)), detail: delta === null ? undefined : `${up ? '▲' : '▼'} ${delta}%`, detailColor: up ? theme.good : theme.bad },
      { title: 'This week', value: formatTokens(motion.number('week', s.week)) },
      { title: 'Streak', value: `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`, detail: `best ${s.longest?.length ?? 0}` },
      { title: 'Est. cost', value: plainCost(month), detail: plainCostDetail(month), shortDetail: '30d' },
      { title: 'Cache hit', value: month.cacheHit === null ? '—' : `${Math.round(month.cacheHit * 100)}%` },
    ];
    drawTiles(view, { x: 0, y: 0, width: view.width, height: tileHeight }, tiles, theme);
  }

  // Heatmap band: large cells from 140 columns (the most recent weeks that fit), else the compact grid, centred.
  const heatmapY = tileHeight + 1;
  const large = view.width >= LARGE_OVERVIEW_WIDTH;
  const heatmapWidth = large ? Math.min(HEATMAP_LARGE_WIDTH, view.width) : Math.min(HEATMAP_FULL_WIDTH, view.width);
  const heatmapX = view.width - heatmapWidth > 4 ? Math.floor((view.width - heatmapWidth) / 2) : 0;
  const grid = yearGrid(vm, state.yearEnd);
  if (state.yearEnd !== vm.today) {
    const first = shiftDate(state.yearEnd, -(52 * 7 - 1)).slice(0, 4);
    const label = `${first}–${state.yearEnd.slice(0, 4)} ◂ [ ] ▸`;
    view.text(heatmapX + Math.max(0, heatmapWidth - label.length), tileHeight, label, { fg: theme.muted });
  }
  const layout = drawHeatmap(view, { x: heatmapX, y: heatmapY, width: heatmapWidth, height: HEATMAP_HEIGHT }, {
    grid,
    theme,
    colorMode,
    cursor: state.cursor,
    today: vm.today,
    motion,
  });

  const day = vm.byDate.get(state.cursor) ?? null;
  const panelProps = { day, date: state.cursor, theme };
  // Chart band: everything below the heatmap, after one blank row.
  const chartY = heatmapY + HEATMAP_HEIGHT + 1;
  const chartHeight = view.height - chartY;
  if (chartHeight >= CHART_MIN_HEIGHT) {
    const column = view.width >= CHART_PANEL_MIN_WIDTH;
    if (column) {
      const chartWidth = view.width - DAY_PANEL_WIDTH - 1;
      drawChart(view, { x: 0, y: chartY, width: chartWidth, height: chartHeight }, props);
      const panelHeight = Math.min(chartHeight, DAY_PANEL_MAX_HEIGHT);
      const panelX = view.width - DAY_PANEL_WIDTH;
      drawDayPanel(view, { x: panelX, y: chartY, width: DAY_PANEL_WIDTH, height: panelHeight }, panelProps);
      if (chartHeight - panelHeight >= CHART_MIN_HEIGHT) {
        drawTopModels(view, { x: panelX, y: chartY + panelHeight, width: DAY_PANEL_WIDTH, height: chartHeight - panelHeight }, props);
      }
    } else {
      // No side column: a narrow terminal keeps the day panel under the chart if it still fits.
      const panelHeight = Math.min(HEATMAP_HEIGHT, chartHeight - CHART_MIN_HEIGHT - 1);
      const withPanel = panelHeight >= MIN_PANEL_HEIGHT;
      const height = withPanel ? chartHeight - panelHeight - 1 : chartHeight;
      drawChart(view, { x: 0, y: chartY, width: view.width, height }, props);
      if (withPanel) {
        drawDayPanel(view, { x: 0, y: chartY + height + 1, width: Math.min(DAY_PANEL_WIDTH, view.width), height: panelHeight }, panelProps);
      }
    }
  } else {
    // Too short for the chart: the one-row sparkline (a blank row below the legend when there is room), with the day panel under it when it fits.
    const seriesY = chartHeight >= 1 ? chartY : heatmapY + HEATMAP_HEIGHT;
    const series = dailySeries(vm, vm.today, SERIES_DAYS);
    const label = 'Last 30 days';
    view.text(0, seriesY, label, { fg: theme.muted });
    const sparkX = label.length + 2;
    drawSparkline(view, sparkX, seriesY, Math.max(0, Math.min(SERIES_DAYS, heatmapWidth - sparkX)), series, theme.accent, theme);
    const peak = Math.max(...series);
    if (peak > 0) {
      const peakDate = shiftDate(vm.today, series.indexOf(peak) - (SERIES_DAYS - 1));
      view.text(sparkX + SERIES_DAYS + 2, seriesY, `peak ${formatTokens(peak)} on ${shortDate(peakDate)}`, { fg: theme.muted });
    }
    const below = view.height - (seriesY + 1);
    if (below >= MIN_PANEL_HEIGHT) {
      drawDayPanel(view, { x: 0, y: seriesY + 1, width: Math.min(DAY_PANEL_WIDTH, view.width), height: Math.min(below, HEATMAP_HEIGHT) }, panelProps);
    }
  }

  blit(buf, view, rect.x, rect.y);
  return {
    hits: [],
    heatmap: { layout: { ...layout, originX: layout.originX + rect.x, originY: layout.originY + rect.y }, grid },
  };
}
