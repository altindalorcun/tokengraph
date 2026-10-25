import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeHours, mergeUsage } from '../../src/ledger.js';
import { STILL } from '../../src/tui/animate.js';
import { MODEL_FAMILIES, formatTokens } from '@tokengraph/core';
import { buildViewModel, modelBreakdown, shiftDate } from '../../src/tui/model.js';
import { shortDate } from '../../src/tui/views/dates.js';
import { ScreenBuffer, toPlainText } from '../../src/tui/screen.js';
import { familyColor, tuiTheme } from '../../src/tui/theme.js';
import { drawAgents } from '../../src/tui/views/agents.js';
import { drawEmpty } from '../../src/tui/views/empty.js';
import { drawHelp } from '../../src/tui/views/help.js';
import { drawInsights } from '../../src/tui/views/insights.js';
import { drawModels } from '../../src/tui/views/models.js';
import { blit } from '../../src/tui/views/props.js';
import { hitTest } from '../../src/tui/widgets/heatmap.js';
import { drawOverview } from '../../src/tui/views/overview.js';
import { MIN_HEIGHT, MIN_WIDTH, drawTooSmall } from '../../src/tui/views/too-small.js';
import { actionItems, type SetupStatus } from '../../src/tui/actions.js';
import { filterEntries, paletteEntries } from '../../src/tui/views/palette.js';
import { initialState, type AppState } from '../../src/tui/app-state.js';
import { renderFrame } from '../../src/tui/frame.js';

const TODAY = '2026-10-03';
const theme = tuiTheme('dark');
const c = (input: number, output = 0) => ({ inputTokens: input, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });

function model() {
  let ledger = emptyLedger();
  for (let i = 0; i < 60; i += 1) {
    ledger = mergeUsage(ledger, 'claude-code', [{ date: shiftDate(TODAY, -i), model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(10_000 * ((i % 7) + 1), 2000) }]);
    if (i % 3 === 0) ledger = mergeUsage(ledger, 'codex-cli', [{ date: shiftDate(TODAY, -i), model: 'gpt-5', pricingTier: 'standard', counts: c(5000) }]);
  }
  return buildViewModel(ledger, TODAY);
}

const base = () => ({ vm: model(), theme, motion: STILL, colorMode: 'per-model' as const });
const table = { range: '30d' as const, selected: 0 };

describe('views', () => {
  it('overview fills 160×40 with big tiles, a large heatmap, the chart, day panel and top models', () => {
    const buf = new ScreenBuffer(160, 40);
    const result = drawOverview(buf, { x: 0, y: 0, width: 160, height: 40 }, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
    const text = toPlainText(buf);
    for (const s of ['TODAY', 'THIS WEEK', 'STREAK', 'EST. COST', 'CACHE SAVED', 'Mon', 'LAST 30 DAYS', 'TOP MODELS', 'Sat 3 Oct 2026']) expect(text).toContain(s);
    expect(text).toMatch(/[┏╺]/);
    expect(result.heatmap!.layout.step).toBe(3);
  });

  it('overview shows cache saved instead of the hit rate, today\'s cost and the delta on This week', () => {
    for (const [w, h, title] of [[160, 48, 'CACHE SAVED'], [100, 30, 'CACHE SAVED']] as const) {
      const buf = new ScreenBuffer(w, h);
      drawOverview(buf, { x: 0, y: 0, width: w, height: h }, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
      const text = toPlainText(buf);
      expect(text).toContain(title);
      expect(text).not.toMatch(/cache hit/i);
      const tileRows = text.split('\n').slice(0, h >= 28 && w >= 140 ? 5 : 3);
      const top = tileRows[1]!;
      // The delta glyph sits inside the This week tile, today's cost inside the Today tile.
      const weekAt = tileRows[0]!.search(/this week/i);
      const streakAt = tileRows[0]!.search(/streak/i);
      expect(top.slice(weekAt, streakAt)).toMatch(/[▲▼]/);
      expect(top.slice(0, weekAt)).not.toMatch(/[▲▼]/);
    }
  });

  it('overview keeps the selected day visible at 100×30 and names it in the chart title without the day panel', () => {
    const cursor = shiftDate(TODAY, -1);
    const vm = model();
    const day = vm.byDate.get(cursor)!;
    for (const [w, h, title] of [[100, 30, false], [80, 24, true], [80, 18, true]] as const) {
      const buf = new ScreenBuffer(w, h);
      drawOverview(buf, { x: 0, y: 0, width: w, height: h }, { ...base(), vm, state: { cursor, yearEnd: TODAY } });
      const text = toPlainText(buf);
      expect(text.toLowerCase()).toContain(shortDate(cursor).toLowerCase());
      expect(text).toContain(formatTokens(day.weighted));
      if (title) expect(text.toLowerCase()).toContain(`${shortDate(cursor)} ${formatTokens(day.weighted)}`.toLowerCase());
    }
  });

  it('agents keep full names and models keep their headers and names on narrow terminals', () => {
    const agents = new ScreenBuffer(100, 30);
    drawAgents(agents, { x: 0, y: 0, width: 100, height: 30 }, { ...base(), state: table, detected: [], autoSync: null });
    expect(toPlainText(agents)).toContain('Claude Code');
    expect(toPlainText(agents)).not.toContain('Claude Co…');

    const wide = new ScreenBuffer(160, 48);
    drawModels(wide, { x: 0, y: 0, width: 160, height: 48 }, { ...base(), state: table });
    expect(toPlainText(wide)).toContain('LAST ACTIVE');
    expect(toPlainText(wide)).toContain('30 DAYS');

    const narrow = new ScreenBuffer(100, 30);
    drawModels(narrow, { x: 0, y: 0, width: 100, height: 30 }, { ...base(), state: table });
    const text = toPlainText(narrow);
    for (const row of modelBreakdown(base().vm, '30d')) expect(text).toContain(row.name);
  });

  it('overview uses large heatmap cells in a real 160-column terminal (158-wide content)', () => {
    const buf = new ScreenBuffer(158, 40);
    const result = drawOverview(buf, { x: 0, y: 0, width: 158, height: 40 }, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
    expect(result.heatmap!.layout.step).toBe(3);
    expect(toPlainText(buf)).toContain('TOP MODELS');
  });

  it('overview tiles never end in an ellipsis and drop a detail that does not fit', () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 30; i += 1) {
      ledger = mergeUsage(ledger, 'codex-cli', [{ date: shiftDate(TODAY, -i), model: 'gpt-5.5', pricingTier: 'standard', counts: c(2_000_000, 200_000) }]);
    }
    ledger = mergeUsage(ledger, 'codex-cli', [{ date: TODAY, model: 'mystery-model-9', pricingTier: 'standard', counts: c(1000) }]);
    const vm = buildViewModel(ledger, TODAY);
    for (const [w, h] of [[80, 22], [100, 24], [160, 40]] as const) {
      const buf = new ScreenBuffer(w, h);
      drawOverview(buf, { x: 0, y: 0, width: w, height: h }, { vm, theme, motion: STILL, colorMode: 'per-model', state: { cursor: TODAY, yearEnd: TODAY } });
      const tiles = toPlainText(buf).split('\n').slice(0, h >= 28 ? 5 : 3).join('\n');
      expect(tiles).not.toContain('…');
      expect(tiles).toContain('EST. COST');
    }
    const plain = new ScreenBuffer(80, 22);
    drawOverview(plain, { x: 0, y: 0, width: 80, height: 22 }, { vm, theme, motion: STILL, colorMode: 'per-model', state: { cursor: TODAY, yearEnd: TODAY } });
    expect(toPlainText(plain).split('\n')[1]).toMatch(/≈ \$\d+(?!\.)/);
  });

  it('overview at 120×30 keeps the compact heatmap beside the day panel and still draws the chart', () => {
    const buf = new ScreenBuffer(120, 30);
    const result = drawOverview(buf, { x: 0, y: 0, width: 120, height: 30 }, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
    const text = toPlainText(buf);
    expect(result.heatmap!.layout.step).toBe(2);
    expect(text).toContain('LAST 30 DAYS');
    expect(text).toContain('Sat 3 Oct 2026');
  });

  it('overview still fits at 80×22 and falls back to the sparkline when under 6 chart rows remain', () => {
    const tall = new ScreenBuffer(80, 22);
    drawOverview(tall, { x: 0, y: 0, width: 80, height: 22 }, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
    expect(toPlainText(tall)).toContain('TODAY');
    expect(toPlainText(tall)).toContain('LAST 30 DAYS');

    const short = new ScreenBuffer(80, 20);
    drawOverview(short, { x: 0, y: 0, width: 80, height: 20 }, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
    const text = toPlainText(short);
    expect(text).toContain('TODAY');
    expect(text).not.toContain('LAST 30 DAYS');
    expect(text).toContain('Last 30 days');
  });

  it('models and agents list breakdowns with range chips', () => {
    const buf = new ScreenBuffer(120, 30);
    const models = drawModels(buf, { x: 0, y: 0, width: 120, height: 30 }, { ...base(), state: table });
    let text = toPlainText(buf);
    expect(text).toContain('30 days');
    expect(text).toContain('Claude Sonnet 4.5');
    expect(text).toContain('gpt-5');
    expect(models.hits.filter((h) => h.kind === 'range')).toHaveLength(5);

    const agentsBuf = new ScreenBuffer(120, 30);
    drawAgents(agentsBuf, { x: 0, y: 0, width: 120, height: 30 }, {
      ...base(), state: table, detected: ['claude-code', 'codex-cli', 'gemini-cli'],
      autoSync: { claudeHook: true, cursorHook: false, codexNotify: false, geminiHook: false, schedule: null },
    });
    text = toPlainText(agentsBuf);
    expect(text).toContain('Claude Code');
    expect(text).toContain('Codex CLI');
    expect(text).toContain('Gemini CLI');
    expect(text).toContain('no usage yet');
    expect(text).toContain('auto-sync');
  });

  it('models and agents fill 160×40 with a stacked chart under the table', () => {
    const models = new ScreenBuffer(160, 40);
    drawModels(models, { x: 0, y: 0, width: 160, height: 40 }, { ...base(), state: table });
    const modelsText = toPlainText(models);
    for (const s of ['TOKENS BY MODEL FAMILY · 30 DAYS', '■ Claude', '■ GPT', 'max ']) expect(modelsText).toContain(s);
    // The chart takes most of the screen: no long blank tail under the table.
    expect(modelsText.split('\n').filter((row) => row.trim() === '').length).toBeLessThan(6);

    const agents = new ScreenBuffer(160, 40);
    drawAgents(agents, { x: 0, y: 0, width: 160, height: 40 }, {
      ...base(), state: { range: '1y', selected: 0 }, detected: ['claude-code'],
      autoSync: { claudeHook: true, cursorHook: false, codexNotify: null, geminiHook: null, schedule: false },
    });
    const agentsText = toPlainText(agents);
    for (const s of ['TOKENS BY AGENT · 1 YEAR', '■ Claude Code', '■ Codex CLI', 'auto-sync']) expect(agentsText).toContain(s);
    expect(agentsText.split('\n').at(-1)).toContain('auto-sync');
  });

  it('never ellipsizes costs, shortens them when narrow and keeps columns two cells apart', () => {
    let ledger = emptyLedger();
    for (const source of ['claude-code', 'codex-cli'] as const) {
      for (let i = 0; i < 30; i += 1) {
        ledger = mergeUsage(ledger, source, [{ date: shiftDate(TODAY, -i), model: 'gpt-5.5', pricingTier: 'standard', counts: c(2_000_000, 200_000) }]);
      }
      ledger = mergeUsage(ledger, source, [{ date: TODAY, model: 'mystery-model-9', pricingTier: 'standard', counts: c(1000) }]);
    }
    const vm = buildViewModel(ledger, TODAY);
    const agents = (w: number, h: number) => {
      const buf = new ScreenBuffer(w, h);
      drawAgents(buf, { x: 0, y: 0, width: w, height: h }, { vm, theme, motion: STILL, colorMode: 'per-model', state: table, detected: [], autoSync: null });
      return toPlainText(buf);
    };
    const wide = agents(160, 40);
    const rows = wide.split('\n').slice(0, 8);
    expect(rows.join('\n')).not.toContain('…');
    expect(rows.join('\n')).toMatch(/\+ unpriced {2,}3 Oct/);
    expect(rows.join('\n')).toMatch(/COST {2,}LAST ACTIVE {2,}30 DAYS/);
    const narrow = agents(70, 40);
    expect(narrow.split('\n').slice(0, 8).join('\n')).not.toContain('…');
    expect(narrow).toMatch(/≈ \$[\d,]+\+/);
    expect(narrow).toContain('+ includes models without a known price');
  });

  it('lists only the legend entries and counts of the columns that fit', () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 90; i += 1) {
      const model = i >= 80 ? 'gpt-5' : 'claude-sonnet-4-5';
      ledger = mergeUsage(ledger, 'claude-code', [{ date: shiftDate(TODAY, -i), model, pricingTier: 'standard', counts: c(10_000) }]);
    }
    const buf = new ScreenBuffer(60, 40);
    drawModels(buf, { x: 0, y: 0, width: 60, height: 40 }, { vm: buildViewModel(ledger, TODAY), theme, motion: STILL, colorMode: 'per-model', state: { range: '90d', selected: 0 } });
    const text = toPlainText(buf);
    expect(text).toContain('90 DAYS · LAST 56');
    expect(text).toContain('■ Claude');
    expect(text).not.toContain('■ GPT');
  });

  it('colours agent chart columns with the accent, never a model-family hue', () => {
    const buf = new ScreenBuffer(160, 40);
    drawAgents(buf, { x: 0, y: 0, width: 160, height: 40 }, { ...base(), state: table, detected: [], autoSync: null });
    const lines = toPlainText(buf).split('\n');
    const top = lines.findIndex((line) => line.includes('TOKENS BY AGENT'));
    const families = new Set(MODEL_FAMILIES.map((f) => familyColor(f, theme)));
    let cells = 0;
    for (let y = top + 2; y < top + 10; y++) {
      for (let x = 0; x < 160; x++) {
        const cell = buf.get(x, y)!;
        if (cell.ch !== '█') continue;
        cells += 1;
        expect(families.has(cell.fg!)).toBe(false);
      }
    }
    expect(cells).toBeGreaterThan(0);
  });

  it('never cuts a word of the busiest-weekday sentence', () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 56; i += 1) {
      const date = shiftDate('2026-09-30', -i); // 2026-09-30 is a Wednesday
      const wednesday = i % 7 === 0;
      ledger = mergeUsage(ledger, 'claude-code', [{ date, model: 'gpt-5', pricingTier: 'standard', counts: c(wednesday ? 500_000 : 1000) }]);
    }
    const buf = new ScreenBuffer(120, 34);
    drawInsights(buf, { x: 0, y: 0, width: 120, height: 34 }, { vm: buildViewModel(ledger, TODAY), theme, motion: STILL, colorMode: 'per-model' });
    const text = toPlainText(buf);
    expect(text).toContain('Wednesday');
    expect(text).not.toMatch(/busi(?!est)|on aver(?!age)|\bWednes(?!day)|\bis y(?!our)/);
  });

  it('keeps the table alone when there is no room for a chart', () => {
    const buf = new ScreenBuffer(120, 16);
    drawModels(buf, { x: 0, y: 0, width: 120, height: 16 }, { ...base(), state: table });
    expect(toPlainText(buf)).not.toContain('TOKENS BY MODEL FAMILY');
  });

  it('insights fills 160×40 with big cards, weekday columns, the months chart and the novels callout', () => {
    const buf = new ScreenBuffer(160, 40);
    drawInsights(buf, { x: 0, y: 0, width: 160, height: 40 }, base());
    const text = toPlainText(buf);
    for (const s of ['LONGEST STREAK', 'LAST 6 MONTHS', 'BUSIEST WEEKDAY', 'Mon', 'Sun', 'Oct', '» You\'ve had AI write']) expect(text).toContain(s);
    expect(text).toMatch(/[┏╺]/);
    expect(text).not.toContain('✎');
    expect(text.split('\n').filter((row) => row.trim() === '').length).toBe(0);
  });

  it('insights omits the novels line without output tokens', () => {
    let ledger = emptyLedger();
    ledger = mergeUsage(ledger, 'claude-code', [{ date: TODAY, model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(1000) }]);
    const buf = new ScreenBuffer(120, 34);
    drawInsights(buf, { x: 0, y: 0, width: 120, height: 34 }, { vm: buildViewModel(ledger, TODAY), theme, motion: STILL, colorMode: 'per-model' });
    expect(toPlainText(buf)).not.toContain('»');
  });

  it('insights shows records and the novels line', () => {
    const buf = new ScreenBuffer(120, 34);
    drawInsights(buf, { x: 0, y: 0, width: 120, height: 34 }, base());
    const text = toPlainText(buf);
    for (const s of ['LONGEST STREAK', 'RECORD DAY', 'FAVOURITE MODEL', 'ACTIVE DAYS', 'BUSIEST WEEKDAY', 'novel']) expect(text).toContain(s);
  });

  it('empty, help and too-small render', () => {
    const buf = new ScreenBuffer(100, 30);
    drawEmpty(buf, { x: 0, y: 0, width: 100, height: 30 }, { theme, scanning: false });
    expect(toPlainText(buf)).toContain('No AI coding usage found yet');
    drawHelp(buf, { x: 0, y: 0, width: 100, height: 30 }, theme);
    expect(toPlainText(buf)).toContain('quit');
    expect(toPlainText(buf)).toContain('weighted tokens');
    const small = new ScreenBuffer(40, 10);
    drawTooSmall(small, { x: 0, y: 0, width: 40, height: 10 }, theme);
    expect(toPlainText(small)).toContain('80');
  });

  it('help drops the glossary on a short screen but keeps the keys', () => {
    const buf = new ScreenBuffer(100, 18);
    drawHelp(buf, { x: 0, y: 0, width: 100, height: 18 }, theme);
    const text = toPlainText(buf);
    expect(text).toContain('quit');
    expect(text).not.toContain('weighted tokens');
  });

  it('blit keeps the target colours under a cell drawn with only a fg', () => {
    const target = new ScreenBuffer(3, 1, { bg: '#123456' });
    const source = new ScreenBuffer(3, 1);
    source.set(1, 0, 'x', { fg: '#abcdef' });
    blit(target, source, 0, 0);
    expect(target.get(1, 0)).toMatchObject({ ch: 'x', fg: '#abcdef', bg: '#123456' });
    expect(target.get(0, 0)).toMatchObject({ ch: ' ', fg: null, bg: '#123456' });
  });

  it('overview reports heatmap coordinates in absolute screen space', () => {
    const buf = new ScreenBuffer(170, 50);
    const result = drawOverview(buf, { x: 5, y: 3, width: 160, height: 40 }, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
    const { layout, grid } = result.heatmap!;
    expect(layout.originX).toBeGreaterThanOrEqual(5 + 4);
    expect(layout.originY).toBeGreaterThanOrEqual(3 + 4);
    expect(hitTest(layout, grid, layout.originX, layout.originY + 1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never writes outside a tiny rect', () => {
    for (const [w, h] of [[1, 1], [10, 3], [30, 8], [79, 23], [160, 40], [101, 29]] as const) {
      const buf = new ScreenBuffer(w + 4, h + 4);
      const rect = { x: 2, y: 2, width: w, height: h };
      drawOverview(buf, rect, { ...base(), state: { cursor: TODAY, yearEnd: TODAY } });
      drawModels(buf, rect, { ...base(), state: table });
      drawAgents(buf, rect, { ...base(), state: table, detected: ['gemini-cli'], autoSync: { claudeHook: true, cursorHook: false, codexNotify: null, geminiHook: null, schedule: false } });
      drawInsights(buf, rect, base());
      drawEmpty(buf, rect, { theme, scanning: true });
      drawHelp(buf, rect, theme);
      drawTooSmall(buf, rect, theme);
      const rows = toPlainText(buf).split('\n');
      expect(rows.slice(0, 2).every((row) => row.trim() === '')).toBe(true);
      expect(rows.slice(h + 2).every((row) => row.trim() === '')).toBe(true);
      expect(rows.every((row) => row.slice(0, 2).trim() === '' && row.length <= w + 2)).toBe(true);
    }
  });

  describe('insights hours', () => {
    function withHours() {
      let ledger = emptyLedger();
      for (let i = 0; i < 20; i += 1) {
        const date = shiftDate(TODAY, -i);
        ledger = mergeUsage(ledger, 'claude-code', [{ date, model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(10_000, 2000) }]);
        ledger = mergeHours(ledger, 'claude-code', [
          { date, hour: 22, weighted: 6000 },
          { date, hour: 23, weighted: 2000 },
          { date, hour: 10, weighted: 4000 },
        ]);
      }
      return buildViewModel(ledger, TODAY);
    }
    const render = (width: number, height: number, vm = withHours(), hour: number | null = null) => {
      const buf = new ScreenBuffer(width, height);
      const result = drawInsights(buf, { x: 0, y: 0, width, height }, { vm, theme, motion: STILL, colorMode: 'per-model', hour });
      return { text: toPlainText(buf), hits: result.hits };
    };

    it('says in words when you code, brackets the day parts and reads out the busiest hour at 160×48', () => {
      const { text } = render(160, 48);
      for (const s of ['BUSIEST HOUR', '22:00', 'WHEN YOU CODE', 'evening 67%', 'morning 33%', 'night 0%', 'afternoon 0%']) expect(text).toContain(s);
      expect(text).toContain('Evening coder  67% of your tokens are used in the evening, 18:00–24:00');
      expect(text).toMatch(/╰─+ evening 67% ─+╯/);
      expect(text).toContain('‹ 22:00–23:00 ›  ·  your busiest hour  ·  120.0K tokens, 50% of all  ·  mostly on');
      expect(text).toContain('← → pick an hour');
      // The old grid and its unexplained peak outline are gone.
      for (const s of ['CODING CLOCK', '▐', 'Peak']) expect(text).not.toContain(s);
    });

    it('reads out the picked hour instead of the busiest, and says when an hour is empty', () => {
      const { text } = render(160, 48, withHours(), 10);
      expect(text).toContain('‹ 10:00–11:00 ›  ·  80.0K tokens, 33% of all');
      expect(text).not.toContain('your busiest hour');
      expect(render(160, 48, withHours(), 4).text).toContain('‹ 04:00–05:00 ›  ·  nothing in this hour yet');
    });

    it('reports one hit per hour over its bar, in screen coordinates', () => {
      const { text, hits } = render(160, 48);
      const hours = hits.filter((h) => h.kind === 'hour');
      expect(hours.map((h) => (h.kind === 'hour' ? h.hour : -1))).toEqual(Array.from({ length: 24 }, (_, i) => i));
      const rows = text.split('\n');
      const labels = rows.find((r) => /^\s*│\s+00\s+03/.test(r))!;
      // The label row sits right under the bars, inside the hit rect, and the 00 label starts at hour 0's column.
      expect(labels.indexOf('00')).toBe(hours[0]!.rect.x);
    });

    it('draws the box above the weekday box at 160×48, and keeps the sentence and readout at 80×24', () => {
      const rows = render(160, 48).text.split('\n');
      expect(rows.findIndex((r) => r.includes('BUSIEST WEEKDAY'))).toBeGreaterThan(rows.findIndex((r) => r.includes('WHEN YOU CODE')));
      const small = render(80, 24).text;
      for (const s of ['WHEN YOU CODE', 'Evening coder', '‹ 22:00–23:00 ›']) expect(small).toContain(s);
      expect(small.split('\n').every((row) => row.length <= 80)).toBe(true);
    });

    it('keeps the card at 70×24 and never writes outside the rect', () => {
      const { text } = render(70, 24);
      expect(text).toContain('BUSIEST HOUR');
      expect(text.split('\n').every((row) => row.length <= 70)).toBe(true);
    });

    it('says there is no hour data yet when none exists, and draws no hour box', () => {
      const { text } = render(120, 34, model());
      expect(text).toContain('BUSIEST HOUR');
      expect(text).toContain('no hour data yet');
      expect(text).not.toContain('WHEN YOU CODE');
    });
  });
});

describe('setup tab and confirm modal', () => {
  const status = (): SetupStatus => ({
    login: 'orcun',
    autoSync: { claudeHook: false, cursorHook: false, codexNotify: false, geminiHook: false, schedule: false },
    cursorFetch: true,
    graphColors: 'per-model',
  });
  const frame = (tab: 'setup' | 'agents' | 'overview', width: number, height: number, extra: Partial<AppState> = {}) =>
    toPlainText(renderFrame({ ...initialState(model(), 'local only'), tab, setup: status(), autoSync: status().autoSync, ...extra }, { theme: 'dark' }, width, height, STILL).buffer);

  it('lists the sections, the recommended hook and the progress header at 160×48', () => {
    const text = frame('setup', 160, 48);
    for (const s of ['ACCOUNT', 'AUTO-SYNC', 'CURSOR', 'YOUR DATA', 'Claude Code hook', 'recommended', 'of 3 recommended steps done', '▸']) expect(text).toContain(s);
    expect(text.split('\n').find((row) => row.includes('Claude Code hook'))).toContain('recommended');
  });

  it('draws one progress segment per step and the selected row\'s command under the list', () => {
    const items = actionItems(status(), model().sources);
    const text = frame('setup', 160, 48, { setupSel: items.findIndex((i) => i.id === 'hook:cursor') });
    expect(text).toContain('1 of 3 recommended steps done  ▰▱▱');
    expect(text).not.toContain('▰▱▱▱');
    expect(text).toContain('$ tokengraph install-hook --agent cursor');
    // Scrolled lists have no room for it.
    expect(frame('setup', 80, 24, { setupSel: items.length - 1 })).not.toContain('$ tokengraph');
  });

  it('draws 4 of 5 as ▰▰▰▰▱', () => {
    const done = status();
    done.autoSync = { claudeHook: true, cursorHook: true, codexNotify: true, geminiHook: false, schedule: false };
    const text = frame('setup', 160, 48, { setup: done, vm: { ...model(), sources: ['claude-code', 'cursor', 'codex-cli', 'opencode'] } });
    expect(text).toContain('4 of 5 recommended steps done  ▰▰▰▰▱');
  });

  it('puts a dot after the Setup tab while a recommended step is open, and drops it when all are done', () => {
    expect(frame('overview', 160, 48).split('\n')[0]).toMatch(/5 Setup •/);
    const done = status();
    done.autoSync = { claudeHook: true, cursorHook: true, codexNotify: true, geminiHook: false, schedule: true };
    const text = frame('setup', 160, 48, { setup: done });
    expect(text.split('\n')[0]).not.toContain('•');
    expect(text).toContain('All set');
  });

  it('shows no dot and says it is reading until the configuration is known', () => {
    const text = frame('setup', 160, 48, { setup: null });
    expect(text.split('\n')[0]).not.toContain('•');
    expect(text).toContain('reading your configuration');
  });

  it('scrolls to keep the selected row visible on a short terminal', () => {
    const items = actionItems(status(), model().sources);
    const text = frame('setup', 80, 24, { setupSel: items.length - 1 });
    expect(text).toContain('Uninstall tokengraph');
    expect(text).toContain('YOUR DATA');
  });

  it('draws the question and its keys over the view', () => {
    const text = frame('setup', 160, 48, { confirm: { id: 'hook:claude-code', text: 'Install the Claude Code hook? It edits Claude Code\'s settings.' } });
    expect(text).toContain('Install the Claude Code hook?');
    expect(text).toContain('y yes  n no');
  });

  it('renders Setup, Agents and the confirm modal at the smallest size and at 100×30 without throwing', () => {
    for (const [w, h] of [[MIN_WIDTH, MIN_HEIGHT], [100, 30]] as const) {
      for (const tab of ['setup', 'agents'] as const) {
        expect(() => frame(tab, w, h)).not.toThrow();
        expect(() => frame(tab, w, h, { setup: null, autoSync: null })).not.toThrow();
        const asked = frame(tab, w, h, { confirm: { id: 'uninstall', text: 'Remove every tokengraph hook and the hourly sync from this machine, and forget the login?' } });
        expect(asked).toContain('y yes  n no');
      }
    }
  });

  it('shows the h manage hint with the Agents statuses', () => {
    expect(frame('agents', 160, 48)).toContain('h manage');
    expect(frame('agents', 100, 30)).toContain('h manage');
  });
});

describe('command palette', () => {
  const frame = (tab: 'overview' | 'models' | 'agents' | 'insights' | 'setup', width: number, height: number, palette: { query: string; selected: number }) =>
    toPlainText(renderFrame({ ...initialState(model(), 'local only'), tab, palette }, { theme: 'dark' }, width, height, STILL).buffer);

  it('draws the query line and the matching entries at 160×48', () => {
    const text = frame('overview', 160, 48, { query: 'hook', selected: 1 });
    for (const s of ['ACTIONS', '› hook', 'Claude Code hook', 'Cursor hook', 'Auto-sync · sync when a session ends']) expect(text).toContain(s);
    expect(text.split('\n').find((row) => row.includes('Cursor hook'))).toContain('▸');
    expect(text.split('\n').find((row) => row.includes('Claude Code hook'))).not.toContain('▸');
  });

  it('highlights the last row when the selection is beyond the list', () => {
    const text = frame('overview', 160, 48, { query: 'hook', selected: 99 });
    const marked = text.split('\n').filter((row) => row.includes('▸'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(filterEntries(paletteEntries(initialState(model(), 'local only')), 'hook').at(-1)!.title);
  });

  it('says no match when nothing fits', () => {
    expect(frame('overview', 160, 48, { query: 'zzzqx', selected: 0 })).toContain('no match');
  });

  it('lists the palette keys in the hints and the help', () => {
    for (const tab of ['overview', 'models', 'agents', 'insights', 'setup'] as const) {
      const rows = toPlainText(renderFrame({ ...initialState(model(), 'local only'), tab }, { theme: 'dark' }, 160, 48, STILL).buffer).split('\n');
      expect(rows[rows.length - 1]).toContain(': actions');
    }
    const buf = new ScreenBuffer(100, 40);
    drawHelp(buf, { x: 0, y: 0, width: 100, height: 40 }, theme);
    expect(toPlainText(buf)).toContain('command palette');
  });

  it('renders on every tab at the smallest size and at 100×30 without throwing', () => {
    for (const [w, h] of [[MIN_WIDTH, MIN_HEIGHT], [100, 30]] as const) {
      for (const tab of ['overview', 'models', 'agents', 'insights', 'setup'] as const) {
        for (const query of ['', 'hook', 'zzzqx', 'a very long query that does not match anything in the palette at all']) {
          expect(() => frame(tab, w, h, { query, selected: 3 })).not.toThrow();
        }
      }
      expect(frame('overview', w, h, { query: 'hook', selected: 0 })).toContain('Claude Code hook');
    }
  });
});

