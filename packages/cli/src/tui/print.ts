import { formatTokens } from '@tokengraph/core';
import type { ColorDepth } from './color.js';
import { STILL } from './animate.js';
import { RANGE_LABELS, busiestHourText, formatCost, hourProfile, modelBreakdown, rangeTotals, stats, yearGrid, type ViewModel } from './model.js';
import { ScreenBuffer, toAnsiLines } from './screen.js';
import { tuiTheme, familyColor } from './theme.js';
import { longDate, truncate } from './views/dates.js';
import { drawBar } from './widgets/bars.js';
import { HEATMAP_FULL_WIDTH, HEATMAP_HEIGHT, drawHeatmap } from './widgets/heatmap.js';
import { drawHeaderMark } from './widgets/logo.js';
import { drawTiles, type Tile } from './widgets/tiles.js';
import type { Theme } from '@tokengraph/core';

const TILE_HEIGHT = 3;
const TOP_MODELS = 5;
const RANGE = '30d';
const MIN_WIDTH = 40;

/** The static snapshot: header, tiles, heatmap and top-5 models, `width` columns wide. */
export function renderSnapshot(
  vm: ViewModel,
  options: { width: number; theme: Theme; depth: ColorDepth; mode: string },
): string {
  const theme = tuiTheme(options.theme);
  const width = Math.max(MIN_WIDTH, Math.floor(options.width));
  const rows = modelBreakdown(vm, RANGE).slice(0, TOP_MODELS);
  const heatmapY = 3 + TILE_HEIGHT + 1;
  const modelsY = heatmapY + HEATMAP_HEIGHT + 1;
  const hoursY = modelsY + 1 + Math.max(1, rows.length) + 1;
  const height = hoursY + 1;
  const buf = new ScreenBuffer(width, height, { fg: theme.ink, bg: theme.bg });

  drawHeaderMark(buf, 1, 0, theme);
  const pill = ` ${truncate(options.mode, Math.max(0, width - 20))} `;
  buf.text(width - 1 - pill.length, 0, pill, { fg: theme.muted, bg: theme.panel });
  buf.fill({ x: 1, y: 2, width: width - 2, height: 1 }, '─', { fg: theme.border });

  const s = stats(vm);
  const month = rangeTotals(vm, RANGE);
  const tiles: Tile[] = [
    { title: 'Today', value: formatTokens(s.today) },
    { title: 'This week', value: formatTokens(s.week) },
    { title: 'Streak', value: `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`, detail: `best ${s.longest?.length ?? 0}` },
    { title: 'Est. cost', value: formatCost(month.cost), detail: RANGE },
    { title: 'Cache hit', value: month.cacheHit === null ? '—' : `${Math.round(month.cacheHit * 100)}%` },
  ];
  const inner = width - 2;
  drawTiles(buf, { x: 1, y: 3, width: inner, height: TILE_HEIGHT }, tiles, theme);

  drawHeatmap(buf, { x: 1, y: heatmapY, width: Math.min(HEATMAP_FULL_WIDTH, inner), height: HEATMAP_HEIGHT }, {
    grid: yearGrid(vm, vm.today),
    theme,
    colorMode: 'per-model',
    cursor: null,
    today: vm.today,
    motion: STILL,
  });

  buf.text(1, modelsY, `Top models · ${RANGE_LABELS[RANGE]}`, { fg: theme.muted });
  if (rows.length === 0) buf.text(1, modelsY + 1, 'No model usage in this range', { fg: theme.faint });
  const nameW = Math.min(28, Math.max(10, ...rows.map((r) => [...r.name].length)));
  const barW = Math.max(0, Math.min(24, inner - nameW - 2 - 8 - 2 - 5 - 2));
  rows.forEach((row, i) => {
    const y = modelsY + 1 + i;
    const color = familyColor(row.family, theme);
    buf.text(1, y, '●', { fg: color });
    buf.text(3, y, truncate(row.name, nameW), { fg: theme.ink }, nameW);
    let x = 3 + nameW + 2;
    if (barW >= 4) {
      drawBar(buf, x, y, barW, row.share, color);
      x += barW + 2;
    }
    const tokens = formatTokens(row.weighted).padStart(8);
    x += buf.text(x, y, tokens, { fg: theme.ink });
    buf.text(x + 2, y, `${Math.round(row.share * 100)}%`.padStart(4), { fg: theme.muted });
  });

  const hours = hourProfile(vm);
  const busiest = busiestHourText(hours);
  buf.text(1, hoursY, 'Busiest hour', { fg: theme.muted });
  const hoursText = busiest === null ? 'no hour data yet' : `${busiest} of tokens (hour data from ${longDate(hours.firstDate!)})`;
  buf.text(14, hoursY, truncate(hoursText, Math.max(0, inner - 13)), { fg: busiest === null ? theme.faint : theme.ink }, Math.max(0, inner - 13));

  const lines = toAnsiLines(buf, options.depth);
  // Without colour, trailing padding is only noise when the output is piped or copied.
  return (options.depth === 'none' ? lines.map((line) => line.replace(/ +$/, '')) : lines).join('\n');
}
