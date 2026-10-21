import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeHours, mergeUsage } from '../../src/ledger.js';
import { STILL } from '../../src/tui/animate.js';
import { MODEL_FAMILIES } from '@tokengraph/core';
import { buildViewModel, shiftDate } from '../../src/tui/model.js';
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
import { drawTooSmall } from '../../src/tui/views/too-small.js';

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
    for (const s of ['TODAY', 'THIS WEEK', 'STREAK', 'EST. COST', 'CACHE HIT', 'Mon', 'LAST 30 DAYS', 'TOP MODELS', 'Sat 3 Oct 2026']) expect(text).toContain(s);
    expect(text).toMatch(/[┏╺]/);
    expect(result.heatmap!.layout.step).toBe(3);
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
    expect(text).toContain('claude-sonnet-4-5');
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

  it('insights fills 160×40 with big cards, weekday columns, the 12-month chart and the novels callout', () => {
    const buf = new ScreenBuffer(160, 40);
    drawInsights(buf, { x: 0, y: 0, width: 160, height: 40 }, base());
    const text = toPlainText(buf);
    for (const s of ['LONGEST STREAK', 'LAST 12 MONTHS', 'BUSIEST WEEKDAY', 'Mon', 'Sun', 'Oct', '» You\'ve had AI write']) expect(text).toContain(s);
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
    const small = new ScreenBuffer(40, 10);
    drawTooSmall(small, { x: 0, y: 0, width: 40, height: 10 }, theme);
    expect(toPlainText(small)).toContain('80');
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
    const render = (width: number, height: number, vm = withHours()) => {
      const buf = new ScreenBuffer(width, height);
      drawInsights(buf, { x: 0, y: 0, width, height }, { vm, theme, motion: STILL, colorMode: 'per-model' });
      return toPlainText(buf);
    };

    it('shows the busiest-hour card, the 24-hour profile and the weekday × hour grid at 160×44', () => {
      const text = render(160, 44);
      for (const s of ['BUSIEST HOUR', '22–23h', 'HOUR OF DAY', 'Mon', 'Sun', '■']) expect(text).toContain(s);
      expect(text).toContain('50% of your tokens');
      expect(text).toContain('hour data from');
    });

    it('drops the grid but keeps the card and the profile at 100×40', () => {
      const text = render(100, 40);
      expect(text).toContain('BUSIEST HOUR');
      expect(text).toContain('HOUR OF DAY');
      expect(text).not.toContain('■');
    });

    it('keeps the card at 70×24 and never writes outside the rect', () => {
      const text = render(70, 24);
      expect(text).toContain('BUSIEST HOUR');
      expect(text.split('\n').every((row) => row.length <= 70)).toBe(true);
    });

    it('says there is no hour data yet when none exists, and draws no hour box', () => {
      const text = render(120, 34, model());
      expect(text).toContain('BUSIEST HOUR');
      expect(text).toContain('no hour data yet');
      expect(text).not.toContain('HOUR OF DAY');
    });
  });
});
