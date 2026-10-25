import { formatTokens } from '@tokengraph/core';
import { mix } from '../color.js';
import { DAY_PARTS, busiestHourText, hourDetail, hourLabel, hourProfile, hourRange, insights, monthlyTotals, type DayPart, type HourProfile } from '../model.js';
import { ScreenBuffer, type Rect } from '../screen.js';
import { familyColor, type TuiTheme } from '../theme.js';
import { bigTextWidth, drawBigText } from '../widgets/big-digits.js';
import { drawBox } from '../widgets/box.js';
import { drawColumns } from '../widgets/sparkline.js';
import { CHART_MIN_HEIGHT, drawColumnChart } from './chart.js';
import { longDate, shortDate, truncate } from './dates.js';
import { blit, type Hit, type ViewProps, type ViewResult } from './props.js';

const CARD_HEIGHT = 6; // border, three big rows, detail, border
const MIN_BIG_CARD_HEIGHT = 5;
const MIN_CARD_HEIGHT = 3;
const WEEKDAY_MIN_HEIGHT = 5;
const WIDE_WIDTH = 140; // cards in one row of four
const CLOCK_HEIGHT = 13; // borders, headline, seven bar rows, hour labels, day parts, readout
const CLOCK_MIN_HEIGHT = 7; // borders, headline, two bar rows, hour labels, readout
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

const MAX_HOUR_WIDTH = 5; // columns per hour: a bar of up to 4 plus a gap
const HOUR_FADE = 0.4; // hours other than the selected one
const PART_RANGES: Record<DayPart, string> = { night: '00:00–06:00', morning: '06:00–12:00', afternoon: '12:00–18:00', evening: '18:00–24:00' };
const PART_PHRASES: Record<DayPart, string> = { night: 'at night', morning: 'in the morning', afternoon: 'in the afternoon', evening: 'in the evening' };
const PART_SHORT: Record<DayPart, string> = { night: 'night', morning: 'morn', afternoon: 'aft', evening: 'eve' };

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** The part of the day with the largest share (a tie goes to the earlier part). */
function topPart(profile: HourProfile): DayPart {
  return DAY_PARTS.reduce((a, b) => (profile.parts[b] > profile.parts[a] ? b : a), DAY_PARTS[0]!);
}

/** "55% of your tokens are used in the evening, 18:00–24:00" — what the persona means, in words. */
function clockHeadline(profile: HourProfile): string {
  const top = topPart(profile);
  if (profile.persona === 'Around the clock') return `no part of the day holds more than ${percent(profile.parts[top])} of your tokens`;
  return `${percent(profile.parts[top])} of your tokens are used ${PART_PHRASES[top]}, ${PART_RANGES[top]}`;
}

/** The label under a six-hour block that fits `width` columns: name and share, short name and share, or the share alone. */
function dayPartText(part: DayPart, share: number, width: number): string {
  for (const name of [part, PART_SHORT[part]]) if (`${name} ${percent(share)}`.length <= width) return `${name} ${percent(share)}`;
  return percent(share);
}

/** The readout for the selected hour, most important first; the caller drops pieces from the end when the row is too narrow. */
function hourReadout(profile: HourProfile, hour: number, theme: TuiTheme): { text: string; color: string; bold?: boolean }[] {
  const detail = hourDetail(profile, hour);
  const parts: { text: string; color: string; bold?: boolean }[] = [{ text: `‹ ${hourRange(hour)} ›`, color: theme.accent, bold: true }];
  if (hour === profile.busiest?.hour) parts.push({ text: 'your busiest hour', color: theme.accent });
  if (detail.weighted > 0) {
    parts.push({ text: `${formatTokens(detail.weighted)} tokens, ${percent(detail.share)} of all`, color: theme.ink });
    if (detail.topWeekday !== null) parts.push({ text: `mostly on ${WEEKDAY_NAMES[detail.topWeekday]}s`, color: theme.muted });
  } else {
    parts.push({ text: 'nothing in this hour yet', color: theme.muted });
  }
  return parts;
}

/**
 * When you code: a sentence saying which part of the day you use AI in, one bar per local hour with the six-hour
 * blocks bracketed under them, and a readout for the selected hour (the busiest until ← → or the mouse picks another).
 * Returns a hit per hour column, view-relative.
 */
function drawClock(view: ScreenBuffer, rect: Rect, profile: HourProfile, selected: number, theme: TuiTheme): Hit[] {
  const inner = drawBox(view, rect, theme, 'When you code');
  const room = inner.width - 2;
  if (inner.height < 3 || room < 24 || profile.busiest === null) return [];

  // Rows: headline, bars, hour labels, day parts, readout. Short boxes drop the day parts first, then the headline.
  let showParts = true;
  let showHeadline = true;
  let barRows = inner.height - 4;
  if (barRows < 3) { showParts = false; barRows += 1; }
  if (barRows < 2) { showHeadline = false; barRows += 1; }
  if (barRows < 1) return [];

  const cell = room >= 48 ? Math.min(MAX_HOUR_WIDTH, Math.floor((room + 1) / 24)) : 1;
  const glyph = cell > 1 ? cell - 1 : 1;
  const used = 24 * cell - (cell > 1 ? 1 : 0);
  const x0 = inner.x + 1 + Math.floor((room - used) / 2);
  const textRoom = inner.x + 1 + room - x0;
  let y = inner.y;

  if (showHeadline) {
    const persona = profile.persona ?? '';
    const since = profile.firstDate ? `since ${longDate(profile.firstDate)}` : '';
    const sentence = clockHeadline(profile);
    let x = x0 + view.text(x0, y, truncate(persona, textRoom), { fg: theme.accent, bold: true }, textRoom);
    const left = x0 + textRoom - x - 2;
    if (left > 0) x += 2 + view.text(x + 2, y, truncate(sentence, left), { fg: theme.ink }, left);
    if (since && x + 3 + since.length <= x0 + used) view.text(x0 + used - since.length, y, since, { fg: theme.muted });
    y += 1;
  }

  const faded = mix(theme.accent, theme.bg, HOUR_FADE);
  const colors = profile.byHour.map((_, hour) => (hour === selected ? theme.accent : faded));
  const bars = { x: x0, y, width: used, height: barRows };
  for (let dx = 0; dx < glyph; dx++) drawColumns(view, { ...bars, x: x0 + dx, width: used - dx }, profile.byHour, colors, cell - 1);
  // An hour without tokens still shows where it is, so the selection never lands on nothing.
  profile.byHour.forEach((value, hour) => {
    if (!(value > 0)) view.text(x0 + hour * cell, y + barRows - 1, '·'.repeat(glyph), { fg: hour === selected ? theme.accent : theme.faint });
  });
  const hits: Hit[] = profile.byHour.map((_, hour) => ({ kind: 'hour', hour, rect: { x: x0 + hour * cell, y, width: cell, height: barRows + 1 } }));
  y += barRows;

  // Hour labels every three hours (six for one-column hours); the selected hour's label is drawn bold and wins over a neighbour.
  const labelEvery = cell === 1 ? 6 : 3;
  for (let hour = 0; hour < 24; hour += labelEvery) {
    if (Math.abs(hour - selected) * cell >= 3) view.text(x0 + hour * cell, y, String(hour).padStart(2, '0'), { fg: theme.muted });
  }
  view.text(x0 + selected * cell, y, String(selected).padStart(2, '0'), { fg: theme.accent, bold: true });
  y += 1;

  if (showParts) {
    // Each six-hour block bracketed ╰─── night 11% ───╯, the largest share in the accent colour.
    const top = topPart(profile);
    DAY_PARTS.forEach((part, i) => {
      const bx = x0 + i * 6 * cell;
      const bw = 6 * cell - (cell > 1 ? 1 : 0);
      const label = dayPartText(part, profile.parts[part], bw);
      const style = part === top ? { fg: theme.accent, bold: true } : { fg: theme.muted };
      if (bw >= label.length + 4) {
        const line = `╰${'─'.repeat(bw - 2)}╯`;
        view.text(bx, y, line, { fg: part === top ? theme.accent : theme.faint });
        view.text(bx + Math.floor((bw - label.length - 2) / 2), y, ` ${label} `, style);
      } else {
        view.text(bx + Math.floor((bw - label.length) / 2), y, label, style, bw);
      }
    });
  }

  // The readout: what the selected hour holds, pieces dropped from the end until it fits, then the key hint if there is room.
  const readoutY = inner.y + inner.height - 1;
  const pieces = hourReadout(profile, selected, theme);
  const sep = '  ·  ';
  const width = (list: typeof pieces) => list.reduce((sum, p, i) => sum + [...p.text].length + (i > 0 ? sep.length : 0), 0);
  while (pieces.length > 1 && width(pieces) > textRoom) pieces.pop();
  let rx = x0;
  pieces.forEach((piece, i) => {
    if (i > 0) rx += view.text(rx, readoutY, sep, { fg: theme.faint });
    rx += view.text(rx, readoutY, truncate(piece.text, textRoom - (rx - x0)), { fg: piece.color, bold: piece.bold }, textRoom - (rx - x0));
  });
  const hint = '← → pick an hour';
  if (rx + 4 + hint.length <= x0 + textRoom) view.text(x0 + textRoom - hint.length, readoutY, hint, { fg: theme.faint });
  return hits;
}

/** "» You've had AI write ≈ 37 novels of output." / "≈ 42% of a novel."; null without any output. */
function novelsLine(novels: number): string | null {
  if (!(novels > 0)) return null;
  if (novels < 1) return `You've had AI write ≈ ${Math.round(novels * 100)}% of a novel.`;
  const rounded = Math.round(novels);
  return `You've had AI write ≈ ${rounded} ${rounded === 1 ? 'novel' : 'novels'} of output.`;
}

/** Record cards, when you code, the weekday profile, the 12-month chart and the novels callout, filling `rect`. `hour` is the selected hour, null for the busiest. */
export function drawInsights(buf: ScreenBuffer, rect: Rect, props: ViewProps & { hour: number | null }): ViewResult {
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
  // "When you code" sits right under the cards and comes first: the weekday and months boxes get what is left.
  const hoursHeight = profile.busiest === null || availableHeight < CLOCK_MIN_HEIGHT ? 0 : Math.min(CLOCK_HEIGHT, availableHeight);
  const hoursY = boxesY;
  const boxesTop = boxesY + hoursHeight;
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
    drawWeekdays(view, { x: 0, y: boxesTop, width: left, height: boxesHeight }, data.weekdays, theme);
    if (monthsFit(boxesHeight)) drawMonths({ x: left, y: boxesTop, width: view.width - left, height: boxesHeight });
  } else if (monthsFit(boxesHeight) && boxesHeight >= WEEKDAY_MIN_HEIGHT + CHART_MIN_HEIGHT) {
    const weekdayHeight = Math.max(WEEKDAY_MIN_HEIGHT, Math.floor(boxesHeight * 0.4));
    drawWeekdays(view, { x: 0, y: boxesTop, width: view.width, height: weekdayHeight }, data.weekdays, theme);
    drawMonths({ x: 0, y: boxesTop + weekdayHeight, width: view.width, height: boxesHeight - weekdayHeight });
  } else if (boxesHeight >= WEEKDAY_MIN_HEIGHT) {
    drawWeekdays(view, { x: 0, y: boxesTop, width: view.width, height: boxesHeight }, data.weekdays, theme);
  }

  const hits: Hit[] = [];
  if (hoursHeight > 0) {
    const selected = props.hour ?? profile.busiest!.hour;
    for (const hit of drawClock(view, { x: 0, y: hoursY, width: view.width, height: hoursHeight }, profile, selected, theme)) {
      hits.push({ ...hit, rect: { ...hit.rect, x: hit.rect.x + rect.x, y: hit.rect.y + rect.y } });
    }
  }

  if (novelsHeight > 0 && novels !== null) {
    const y = view.height - 1;
    view.text(0, y, '»', { fg: theme.muted });
    view.text(2, y, novels, { fg: theme.ink }, Math.max(0, view.width - 2));
  }

  blit(buf, view, rect.x, rect.y);
  return { hits };
}
