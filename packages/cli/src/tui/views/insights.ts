import { cellColor, computeThresholds, formatTokens, levelFor } from '@tokengraph/core';
import { mix } from '../color.js';
import { DAY_PARTS, busiestHourText, hourLabel, hourProfile, hourRange, insights, monthlyTotals, type DayPart, type HourProfile } from '../model.js';
import { ScreenBuffer, type Rect } from '../screen.js';
import { familyColor, type TuiTheme } from '../theme.js';
import { bigTextWidth, drawBigText } from '../widgets/big-digits.js';
import { drawBox } from '../widgets/box.js';
import { drawColumns } from '../widgets/sparkline.js';
import { CHART_MIN_HEIGHT, drawColumnChart } from './chart.js';
import { longDate, shortDate, truncate } from './dates.js';
import { blit, type ViewProps, type ViewResult } from './props.js';

const CARD_HEIGHT = 6; // border, three big rows, detail, border
const MIN_BIG_CARD_HEIGHT = 5;
const MIN_CARD_HEIGHT = 3;
const WEEKDAY_MIN_HEIGHT = 5;
const WIDE_WIDTH = 140; // cards in one row of four
const HOURS_GRID_HEIGHT = 13; // borders, hour labels, seven weekday rows, two bar rows, day parts
const HOURS_PROFILE_HEIGHT = 8;
const CARD_COUNT = 5;
const SIDE_BY_SIDE_WIDTH = 120; // weekday and months boxes next to each other
const WEEKDAY_SHARE = 0.45;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const COLUMN_WIDTH = 3;
const COLUMN_GAP = 2;
const MONTH_FADE = 0.4; // months before the current one

interface Card {
  title: string;
  /** The headline as plain text, used when the big digits do not fit. */
  value: string;
  /** Seven-segment form of the headline (digits plus a small unit); defaults to `value`. */
  big?: string;
  /** Plain text in this colour instead of big digits (the favourite model's name); `big` then goes under it. */
  valueColor?: string;
  detail?: string;
  /** Used instead of `detail` when that is wider than the card. */
  shortDetail?: string;
}

function drawCard(view: ScreenBuffer, rect: Rect, card: Card, theme: TuiTheme): void {
  const inner = drawBox(view, rect, theme, card.title);
  if (inner.height < 1 || inner.width < 3) return;
  const x = inner.x + 1;
  const room = inner.width - 2;
  if (card.shortDetail !== undefined && card.detail !== undefined && [...card.detail].length > room) card = { ...card, detail: card.shortDetail };
  const big = card.big ?? card.value;
  const fits = bigTextWidth(big) > 0 && bigTextWidth(big) <= room;

  if (card.valueColor !== undefined) {
    // Text headline in its own colour; the weighted tokens go big underneath when three more rows are free.
    view.text(x, inner.y, truncate(card.value, room), { fg: card.valueColor, bold: true }, room);
    if (inner.height >= 4 && card.big !== undefined && fits) {
      drawBigText(view, x, inner.y + 1, big, theme.ink, theme.accent);
    } else if (inner.height >= 2 && card.detail) {
      view.text(x, inner.y + 1, card.detail, { fg: theme.muted }, room);
    }
    return;
  }

  if (rect.height < MIN_BIG_CARD_HEIGHT || !fits) {
    const used = view.text(x, inner.y, truncate(card.value, room), { fg: theme.ink, bold: true }, room);
    if (inner.height === 1 && card.detail && room - used > 2) view.text(x + used + 2, inner.y, card.detail, { fg: theme.muted }, room - used - 2);
    if (inner.height >= 2 && card.detail) view.text(x, inner.y + 1, card.detail, { fg: theme.muted }, room);
    return;
  }
  drawBigText(view, x, inner.y, big, theme.ink, theme.accent);
  if (inner.height >= 4 && card.detail) view.text(x, inner.y + 3, card.detail, { fg: theme.muted }, room);
  else if (card.detail && room - bigTextWidth(big) > 2) view.text(x + bigTextWidth(big) + 2, inner.y + 1, card.detail, { fg: theme.muted }, room - bigTextWidth(big) - 2);
}

/** Greedy word wrap to `width` columns; null when a single word is wider than that (a word is never cut). */
function wrapWords(text: string, width: number): string[] | null {
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    if ([...word].length > width) return null;
    const last = lines[lines.length - 1];
    if (last !== undefined && [...last].length + 1 + [...word].length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** Seven columns of three cells with two gaps when that fits, else single cells; the busiest day in the accent colour. */
function drawWeekdays(view: ScreenBuffer, rect: Rect, weekdays: readonly number[], theme: TuiTheme): void {
  const inner = drawBox(view, rect, theme, 'Busiest weekday');
  const room = inner.width - 2;
  if (inner.height < 2 || room < 9) return;
  const max = Math.max(0, ...weekdays);
  const busiest = max > 0 ? weekdays.indexOf(max) : -1;
  const wide = room >= weekdays.length * COLUMN_WIDTH + (weekdays.length - 1) * COLUMN_GAP;
  const width = wide ? COLUMN_WIDTH : 1;
  const gap = wide ? COLUMN_GAP : Math.max(0, Math.min(3, Math.floor((room - weekdays.length) / (weekdays.length - 1))));
  const step = width + gap;
  const x = inner.x + 1;
  const colors = weekdays.map((_, i) => (i === busiest ? theme.accent : theme.muted));
  const chart = { x, y: inner.y, width: room, height: inner.height - 1 };
  // drawColumns draws single-cell columns: one pass per cell of the column width, spaced by the full step.
  for (let dx = 0; dx < width; dx++) drawColumns(view, { ...chart, x: x + dx, width: room - dx }, weekdays, colors, step - 1);
  const labelY = inner.y + inner.height - 1;
  weekdays.forEach((_, i) => view.text(x + i * step, labelY, wide ? WEEKDAY_SHORT[i]! : WEEKDAY_LETTERS[i]!, { fg: i === busiest ? theme.accent : theme.muted, bold: i === busiest }));
  if (busiest >= 0) {
    const textX = x + weekdays.length * step - gap + 3;
    const textRoom = inner.x + inner.width - 1 - textX;
    const lines = wrapWords(`${WEEKDAY_NAMES[busiest]} is your busiest day, ${formatTokens(max)} on average`, textRoom);
    if (lines !== null && lines.length <= inner.height - 1) {
      const y = inner.y + Math.floor((inner.height - 1 - lines.length) / 2);
      lines.forEach((line, i) => view.text(textX, y + i, line, { fg: i === 0 ? theme.ink : theme.muted }, textRoom));
    }
  }
}

const HOUR_LABEL_WIDTH = 4; // "Mon "
const SIDE_PANEL_WIDTH = 26;
const SIDE_GAP = 3;
const DAY_PART_SHORT: Record<DayPart, string> = { night: 'night', morning: 'morn', afternoon: 'aft', evening: 'eve' };

interface ClockLayout {
  /** Columns per hour cell: 3 (block, block, gap), 2 or 1. */
  cell: 1 | 2 | 3;
  /** Persona, peak, busiest hour and first date to the right of the grid; otherwise one line under the day parts. */
  side: boolean;
  /** Rows the box needs, borders included. */
  height: number;
}

/** What the coding clock can be drawn as in `room` columns; null when even single-column cells do not fit. */
function clockLayout(room: number): ClockLayout | null {
  const grid = (cell: number) => HOUR_LABEL_WIDTH + 24 * cell;
  if (room >= grid(3) + SIDE_GAP + SIDE_PANEL_WIDTH) return { cell: 3, side: true, height: HOURS_GRID_HEIGHT };
  if (room >= grid(2) + SIDE_GAP + SIDE_PANEL_WIDTH) return { cell: 2, side: true, height: HOURS_GRID_HEIGHT };
  if (room >= grid(2)) return { cell: 2, side: false, height: HOURS_GRID_HEIGHT + 1 };
  if (room >= grid(1)) return { cell: 1, side: false, height: HOURS_GRID_HEIGHT + 1 };
  return null;
}

/** "Night owl · peak Sun 23:00 · since 19 Jun 2026" */
function clockSummary(profile: HourProfile): string {
  const peak = profile.peak ? ` · peak ${WEEKDAY_SHORT[profile.peak.weekday]} ${hourLabel(profile.peak.hour)}` : '';
  const since = profile.firstDate ? ` · since ${longDate(profile.firstDate)}` : '';
  return `${profile.persona ?? ''}${peak}${since}`;
}

/** The part-of-day label that fits `width` columns: full name, short name, or the percentage alone. */
function dayPartText(part: DayPart, share: number, width: number): string {
  const pct = `${Math.round(share * 100)}%`;
  for (const name of [part, DAY_PART_SHORT[part]]) if (`${name} ${pct}`.length <= width) return `${name} ${pct}`;
  return pct;
}

/**
 * The coding clock: weekday × hour cells in the year heatmap's colours (the peak cell outlined), an "All" bar per hour,
 * the share of each part of the day and, beside the grid, what it says about you. Too little height gives the compact profile.
 */
function drawHours(view: ScreenBuffer, rect: Rect, profile: HourProfile, theme: TuiTheme): void {
  const inner = drawBox(view, rect, theme, 'Coding clock');
  const room = inner.width - 2;
  if (inner.height < 4 || room < 24 || profile.busiest === null) return;
  const x = inner.x + 1;
  const layout = clockLayout(room);
  const faded = mix(theme.accent, theme.bg, MONTH_FADE);
  const best = profile.busiest.hour;
  const barColors = profile.byHour.map((_, hour) => (hour === best ? theme.accent : faded));

  if (layout === null || inner.height < layout.height - 2) {
    // Compact: the 24-hour profile, hour labels under it and the one-line summary.
    const cell = room >= 48 ? 2 : 1;
    const chartHeight = inner.height - 2; // labels and summary
    drawColumns(view, { x, y: inner.y, width: 24 * cell, height: chartHeight }, profile.byHour, barColors, cell - 1);
    const labelEvery = cell === 2 ? 3 : 6;
    // The busiest hour's label is drawn bold below, so a regular label that would touch it is left out.
    for (let hour = 0; hour < 24; hour += labelEvery) {
      if (Math.abs(hour - best) * cell > 2) view.text(x + hour * cell, inner.y + chartHeight, String(hour).padStart(2, '0'), { fg: theme.muted });
    }
    view.text(x + best * cell, inner.y + chartHeight, String(best).padStart(2, '0'), { fg: theme.accent, bold: true });
    view.text(x, inner.y + inner.height - 1, truncate(clockSummary(profile), room), { fg: theme.accent }, room);
    return;
  }

  const { cell, side } = layout;
  const gx = x + HOUR_LABEL_WIDTH;
  const labelEvery = cell === 1 ? 6 : 3;
  for (let hour = 0; hour < 24; hour += labelEvery) view.text(gx + hour * cell, inner.y, String(hour).padStart(2, '0'), { fg: theme.muted });

  // Same single-colour ramp as the year heatmap; levels come from the person's own non-zero hour cells.
  const thresholds = computeThresholds(profile.grid.flat());
  profile.grid.forEach((row, weekday) => {
    const y = inner.y + 1 + weekday;
    view.text(x, y, WEEKDAY_SHORT[weekday]!, { fg: theme.muted });
    row.forEach((value, hour) => {
      const cx = gx + hour * cell;
      if (!(value > 0)) {
        view.set(cx, y, '·', { fg: theme.faint });
        return;
      }
      const color = cellColor(levelFor(value, thresholds), { colorMode: 'single', theme: theme.name, empty: theme.empty });
      const isPeak = profile.peak?.weekday === weekday && profile.peak.hour === hour;
      if (isPeak && cell === 3) {
        view.set(cx, y, '▐', { fg: theme.ink, bold: true });
        view.set(cx + 1, y, '█', { fg: color });
        view.set(cx + 2, y, '▌', { fg: theme.ink, bold: true });
      } else {
        view.set(cx, y, isPeak && cell === 1 ? '◆' : '█', { fg: isPeak && cell === 1 ? theme.ink : color, bold: isPeak });
        if (cell >= 2) view.set(cx + 1, y, isPeak ? '▌' : cell === 3 ? '█' : ' ', { fg: isPeak ? theme.ink : color, bold: isPeak });
      }
    });
  });

  // The "All" row: one eighth-block bar per hour, two rows tall.
  const barsY = inner.y + 8;
  const barRect = { x: gx, y: barsY, width: 24 * cell, height: 2 };
  for (let dx = 0; dx < Math.min(cell, 2); dx++) drawColumns(view, { ...barRect, x: gx + dx }, profile.byHour, barColors, cell - 1);
  view.text(x, barsY + 1, 'All', { fg: theme.muted });

  // Under each six-hour block: its share of the day, the biggest in the accent colour.
  const partsY = inner.y + 10;
  const blockWidth = 6 * cell;
  const top = DAY_PARTS.reduce((a, b) => (profile.parts[b] > profile.parts[a] ? b : a), DAY_PARTS[0]!);
  DAY_PARTS.forEach((part, i) => {
    const text = dayPartText(part, profile.parts[part], blockWidth);
    view.text(gx + i * blockWidth + Math.floor((blockWidth - text.length) / 2), partsY, text, part === top ? { fg: theme.accent, bold: true } : { fg: theme.muted }, blockWidth);
  });

  if (side) {
    const sx = gx + 24 * cell + SIDE_GAP;
    const sideRoom = inner.x + inner.width - 1 - sx;
    view.text(sx, inner.y + 1, truncate(profile.persona ?? '', sideRoom), { fg: theme.accent, bold: true }, sideRoom);
    const rows: [string, string][] = [
      ['Peak', profile.peak ? `${WEEKDAY_SHORT[profile.peak.weekday]} ${hourLabel(profile.peak.hour)}` : '—'],
      ['Busiest', `${hourRange(best)} · ${Math.round(profile.busiest.share * 100)}%`],
      ['Since', profile.firstDate ? longDate(profile.firstDate) : '—'],
    ];
    rows.forEach(([label, value], i) => {
      view.text(sx, inner.y + 3 + i, label.padEnd(9), { fg: theme.muted }, sideRoom);
      view.text(sx + 9, inner.y + 3 + i, truncate(value, Math.max(0, sideRoom - 9)), { fg: theme.ink }, Math.max(0, sideRoom - 9));
    });
  } else {
    view.text(x, inner.y + 11, truncate(clockSummary(profile), room), { fg: theme.accent }, room);
  }
}

/** "» You've had AI write ≈ 37 novels of output." / "≈ 42% of a novel."; null without any output. */
function novelsLine(novels: number): string | null {
  if (!(novels > 0)) return null;
  if (novels < 1) return `You've had AI write ≈ ${Math.round(novels * 100)}% of a novel.`;
  const rounded = Math.round(novels);
  return `You've had AI write ≈ ${rounded} ${rounded === 1 ? 'novel' : 'novels'} of output.`;
}

/** Record cards, the weekday profile, the 12-month chart and the novels callout, filling `rect`. */
export function drawInsights(buf: ScreenBuffer, rect: Rect, props: ViewProps): ViewResult {
  const { vm, theme } = props;
  const view = new ScreenBuffer(rect.width, rect.height);
  const data = insights(vm);
  const profile = hourProfile(vm);

  const cards: Card[] = [
    {
      title: 'Longest streak',
      value: data.longest ? `${data.longest.length} ${data.longest.length === 1 ? 'day' : 'days'}` : '—',
      big: data.longest ? `${data.longest.length}d` : '—',
      detail: data.longest ? `${shortDate(data.longest.start)} – ${longDate(data.longest.end)}` : undefined,
    },
    {
      title: 'Record day',
      value: data.record ? formatTokens(data.record.weighted) : '—',
      detail: data.record ? longDate(data.record.date) : undefined,
    },
    {
      title: 'Favourite model',
      value: data.favourite ? data.favourite.name : '—',
      big: data.favourite ? formatTokens(data.favourite.weighted) : undefined,
      valueColor: data.favourite ? familyColor(data.favourite.family, theme) : undefined,
      detail: data.favourite ? `${formatTokens(data.favourite.weighted)} weighted tokens` : undefined,
    },
    {
      title: 'Busiest hour',
      value: busiestHourText(profile) ?? '—',
      big: profile.busiest ? hourLabel(profile.busiest.hour) : '—',
      detail: profile.busiest ? `${Math.round(profile.busiest.share * 100)}% of tokens · ${profile.persona}` : 'no hour data yet',
      shortDetail: profile.busiest ? `${Math.round(profile.busiest.share * 100)}% · ${profile.persona}` : undefined,
    },
    {
      title: 'Active days',
      value: String(data.activeDays),
      detail: data.firstDay ? `since ${longDate(data.firstDay)}` : undefined,
    },
  ];

  const novels = novelsLine(data.novels);
  const novelsHeight = novels !== null && view.height >= 10 ? 1 : 0;
  const remaining = view.height - novelsHeight;
  const perRow = view.width >= WIDE_WIDTH ? CARD_COUNT : 3;
  const cardRows = Math.ceil(CARD_COUNT / perRow);
  let cardHeight = Math.min(CARD_HEIGHT, Math.floor((remaining - WEEKDAY_MIN_HEIGHT) / cardRows));
  if (cardHeight < MIN_CARD_HEIGHT) cardHeight = Math.min(MIN_CARD_HEIGHT, Math.floor(remaining / cardRows));
  const showCards = cardHeight >= MIN_CARD_HEIGHT;
  if (showCards) {
    for (let row = 0; row < cardRows; row++) {
      const items = cards.slice(row * perRow, (row + 1) * perRow);
      // The cards of a row share its width, so a short last row stretches instead of leaving a gap.
      const base = Math.floor(view.width / items.length);
      const extra = view.width - base * items.length;
      items.forEach((card, column) => {
        const x = column * base + Math.min(column, extra);
        drawCard(view, { x, y: row * cardHeight, width: base + (column < extra ? 1 : 0), height: cardHeight }, card, theme);
      });
    }
  }

  // Everything under the cards: the weekday and months boxes, next to each other on wide screens.
  const boxesY = showCards ? cardHeight * cardRows : 0;
  const availableHeight = remaining - boxesY;
  // The hour box sits under the weekday and months boxes; it is left out when they would get less than their minimum.
  const hoursRoom = view.width - 4;
  const clockHeight = clockLayout(hoursRoom)?.height ?? HOURS_PROFILE_HEIGHT;
  let hoursHeight = profile.busiest === null ? 0 : clockHeight;
  if (hoursHeight > 0 && availableHeight - hoursHeight < WEEKDAY_MIN_HEIGHT) hoursHeight = availableHeight - HOURS_PROFILE_HEIGHT >= WEEKDAY_MIN_HEIGHT ? HOURS_PROFILE_HEIGHT : 0;
  const boxesHeight = availableHeight - hoursHeight;
  const monthsFit = (height: number) => height >= CHART_MIN_HEIGHT;
  // The 12-month chart: one accent column per month, the current month at full strength.
  const drawMonths = (area: Rect) => {
    const months = monthlyTotals(vm);
    const faded = mix(theme.accent, theme.bg, MONTH_FADE);
    drawColumnChart(view, area, theme, {
      title: `Last ${monthlyTotals(vm).length} months`,
      columns: months.map((m, i) => ({
        label: m.label,
        segments: [{ value: m.weighted, color: i === months.length - 1 ? theme.accent : faded }],
        highlight: i === months.length - 1,
      })),
    });
  };
  if (view.width >= SIDE_BY_SIDE_WIDTH && boxesHeight >= WEEKDAY_MIN_HEIGHT) {
    const left = Math.floor(view.width * WEEKDAY_SHARE);
    drawWeekdays(view, { x: 0, y: boxesY, width: left, height: boxesHeight }, data.weekdays, theme);
    if (monthsFit(boxesHeight)) drawMonths({ x: left, y: boxesY, width: view.width - left, height: boxesHeight });
  } else if (monthsFit(boxesHeight) && boxesHeight >= WEEKDAY_MIN_HEIGHT + CHART_MIN_HEIGHT) {
    const weekdayHeight = Math.max(WEEKDAY_MIN_HEIGHT, Math.floor(boxesHeight * 0.4));
    drawWeekdays(view, { x: 0, y: boxesY, width: view.width, height: weekdayHeight }, data.weekdays, theme);
    drawMonths({ x: 0, y: boxesY + weekdayHeight, width: view.width, height: boxesHeight - weekdayHeight });
  } else if (boxesHeight >= WEEKDAY_MIN_HEIGHT) {
    drawWeekdays(view, { x: 0, y: boxesY, width: view.width, height: boxesHeight }, data.weekdays, theme);
  }

  if (hoursHeight > 0) drawHours(view, { x: 0, y: boxesY + boxesHeight, width: view.width, height: hoursHeight }, profile, theme);

  if (novelsHeight > 0 && novels !== null) {
    const y = view.height - 1;
    view.text(0, y, '»', { fg: theme.muted });
    view.text(2, y, novels, { fg: theme.ink }, Math.max(0, view.width - 2));
  }

  blit(buf, view, rect.x, rect.y);
  return { hits: [] };
}
