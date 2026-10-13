import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeUsage } from '../../src/ledger.js';
import { STILL } from '../../src/tui/animate.js';
import { buildViewModel, shiftDate, yearGrid } from '../../src/tui/model.js';
import { ScreenBuffer, toPlainText } from '../../src/tui/screen.js';
import { tuiTheme } from '../../src/tui/theme.js';
import { DAY_PANEL_WIDTH, drawDayPanel } from '../../src/tui/widgets/day-panel.js';
import { HEATMAP_FULL_WIDTH, HEATMAP_HEIGHT, HEATMAP_LARGE_MIN_WIDTH, HEATMAP_LARGE_WIDTH, drawHeatmap, hitTest } from '../../src/tui/widgets/heatmap.js';

const TODAY = '2026-10-03'; // a Saturday
const theme = tuiTheme('dark');
const c = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });

function vm() {
  let ledger = emptyLedger();
  for (let i = 0; i < 40; i += 1) {
    ledger = mergeUsage(ledger, 'claude-code', [{ date: shiftDate(TODAY, -i), model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(1000 * (i + 1)) }]);
  }
  ledger = mergeUsage(ledger, 'codex-cli', [{ date: TODAY, model: 'gpt-5', pricingTier: 'standard', counts: c(500) }]);
  return buildViewModel(ledger, TODAY);
}

describe('heatmap', () => {
  it('draws 52 weeks with labels at full width', () => {
    const model = vm();
    const buf = new ScreenBuffer(HEATMAP_FULL_WIDTH, HEATMAP_HEIGHT);
    const layout = drawHeatmap(buf, { x: 0, y: 0, width: HEATMAP_FULL_WIDTH, height: HEATMAP_HEIGHT }, {
      grid: yearGrid(model, TODAY), theme, colorMode: 'per-model', cursor: null, today: TODAY, motion: STILL,
    });
    expect(layout.firstColumn).toBe(0);
    const rows = toPlainText(buf).split('\n');
    expect(rows[2]!.startsWith('Mon ')).toBe(true);
    expect(rows[0]).toMatch(/Oct|Nov/);
    expect(rows[1]!.split('▀').length - 1).toBe(52);
    expect(rows[9]).toContain('Less');
    expect(rows[9]).toContain('Claude');
  });

  it('shows only the recent weeks when narrow and hit-tests cells', () => {
    const model = vm();
    const grid = yearGrid(model, TODAY);
    const buf = new ScreenBuffer(44, HEATMAP_HEIGHT);
    const layout = drawHeatmap(buf, { x: 0, y: 0, width: 44, height: HEATMAP_HEIGHT }, {
      grid, theme, colorMode: 'single', cursor: TODAY, today: TODAY, motion: STILL,
    });
    expect(layout.firstColumn).toBe(52 - 20);
    // today is Saturday: last column, row 6
    const x = layout.originX + 2 * (51 - layout.firstColumn);
    const y = layout.originY + 6;
    expect(hitTest(layout, grid, x, y)).toBe(TODAY);
    expect(hitTest(layout, grid, x + 1, y)).toBeNull(); // the gap column is not a cell
    expect(buf.get(x, y)!.ch).toBe('█');
    expect(buf.get(x - 1, y)!.ch).toBe('▐');
  });

  it('draws large cells from 160 columns and hit-tests both cell columns', () => {
    expect(HEATMAP_LARGE_WIDTH).toBe(160);
    const model = vm();
    const grid = yearGrid(model, TODAY);
    const buf = new ScreenBuffer(160, HEATMAP_HEIGHT);
    const layout = drawHeatmap(buf, { x: 0, y: 0, width: 160, height: HEATMAP_HEIGHT }, {
      grid, theme, colorMode: 'single', cursor: null, today: TODAY, motion: STILL,
    });
    expect(layout.step).toBe(3);
    expect(layout.firstColumn).toBe(0);
    const rows = toPlainText(buf).split('\n');
    expect(rows[1]!.split('▇▇').length - 1).toBe(52);
    expect(rows[1]!.startsWith('    ▇▇ ▇▇ ')).toBe(true);
    expect(rows[9]).toContain('Less ▇▇ ▇▇ ▇▇ ▇▇ ▇▇ ▇▇ More');
    const x = layout.originX + 3 * 51;
    const y = layout.originY + 6;
    expect(hitTest(layout, grid, x, y)).toBe(TODAY);
    expect(hitTest(layout, grid, x + 1, y)).toBe(TODAY);
    expect(hitTest(layout, grid, x + 2, y)).toBeNull();
    expect(hitTest(layout, grid, x - 3, y)).toBe(shiftDate(TODAY, -7));
  });

  it('keeps large cells down to 124 columns and shows the most recent weeks', () => {
    expect(HEATMAP_LARGE_MIN_WIDTH).toBe(124);
    const model = vm();
    const grid = yearGrid(model, TODAY);
    const buf = new ScreenBuffer(130, HEATMAP_HEIGHT);
    const layout = drawHeatmap(buf, { x: 0, y: 0, width: 130, height: HEATMAP_HEIGHT }, {
      grid, theme, colorMode: 'single', cursor: null, today: TODAY, motion: STILL,
    });
    expect(layout.step).toBe(3);
    expect(layout.firstColumn).toBe(52 - 42);
    expect(toPlainText(buf).split('\n')[1]!.split('▇▇').length - 1).toBe(42);
    const x = layout.originX + 3 * 41;
    expect(hitTest(layout, grid, x, layout.originY + 6)).toBe(TODAY);
    const narrow = drawHeatmap(new ScreenBuffer(123, HEATMAP_HEIGHT), { x: 0, y: 0, width: 123, height: HEATMAP_HEIGHT }, {
      grid, theme, colorMode: 'single', cursor: null, today: TODAY, motion: STILL,
    });
    expect(narrow.step).toBe(2);
  });

  it('draws the large-mode cursor as two full blocks without brackets', () => {
    const grid = yearGrid(vm(), TODAY);
    const buf = new ScreenBuffer(160, HEATMAP_HEIGHT);
    const layout = drawHeatmap(buf, { x: 0, y: 0, width: 160, height: HEATMAP_HEIGHT }, {
      grid, theme, colorMode: 'single', cursor: TODAY, today: TODAY, motion: STILL,
    });
    const x = layout.originX + 3 * 51;
    const y = layout.originY + 6;
    expect(buf.get(x, y)!.ch).toBe('█');
    expect(buf.get(x + 1, y)!.ch).toBe('█');
    expect(toPlainText(buf)).not.toMatch(/[▐▌▀]/);
  });

  it('never truncates a month label', () => {
    const grid = yearGrid(vm(), TODAY);
    const labels = grid.months.map((m) => m.label);
    for (let width = 8; width <= 170; width++) {
      const buf = new ScreenBuffer(width, HEATMAP_HEIGHT);
      drawHeatmap(buf, { x: 0, y: 0, width, height: HEATMAP_HEIGHT }, {
        grid, theme, colorMode: 'single', cursor: null, today: TODAY, motion: STILL,
      });
      const words = toPlainText(buf).split('\n')[0]!.split(/ +/).filter(Boolean);
      for (const word of words) expect(labels).toContain(word);
    }
  });

  it('never draws outside its rect', () => {
    const model = vm();
    const buf = new ScreenBuffer(130, 16);
    const rect = { x: 5, y: 3, width: 40, height: HEATMAP_HEIGHT };
    drawHeatmap(buf, rect, {
      grid: yearGrid(model, TODAY), theme, colorMode: 'per-model', cursor: TODAY, today: TODAY, motion: STILL,
    });
    expectNothingOutside(buf, rect);
  });

  it('moves today toward white (dark) or black (light) while the pulse is up', () => {
    const model = vm();
    const grid = yearGrid(model, TODAY);
    const sum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    for (const name of ['dark', 'light'] as const) {
      const fgAt = (pulse: number) => {
        const buf = new ScreenBuffer(HEATMAP_FULL_WIDTH, HEATMAP_HEIGHT);
        const layout = drawHeatmap(buf, { x: 0, y: 0, width: HEATMAP_FULL_WIDTH, height: HEATMAP_HEIGHT }, {
          grid, theme: tuiTheme(name), colorMode: 'single', cursor: null, today: TODAY, motion: { ...STILL, pulse },
        });
        return buf.get(layout.originX + 2 * 51, layout.originY + 6)!.fg!;
      };
      const settled = fgAt(0);
      const pulsed = fgAt(1);
      expect(pulsed).not.toBe(settled);
      if (name === 'dark') expect(sum(pulsed)).toBeGreaterThan(sum(settled));
      else expect(sum(pulsed)).toBeLessThan(sum(settled));
    }
  });

  it('draws no cursor for a null slot or a date outside the window', () => {
    const model = vm();
    const cursors: [string, string][] = [
      ['2026-09-30', '2026-10-02'], // grid ends midweek: Friday is a null slot
      [TODAY, '2020-01-01'], // before the window
      [TODAY, shiftDate(TODAY, 1)], // after the window
    ];
    for (const [end, cursor] of cursors) {
      const buf = new ScreenBuffer(HEATMAP_FULL_WIDTH, HEATMAP_HEIGHT);
      drawHeatmap(buf, { x: 0, y: 0, width: HEATMAP_FULL_WIDTH, height: HEATMAP_HEIGHT }, {
        grid: yearGrid(model, end), theme, colorMode: 'single', cursor, today: end, motion: STILL,
      });
      expect(toPlainText(buf)).not.toMatch(/[█▐▌]/);
    }
  });
});

/** Fails if any cell outside `rect` was written (character or colour). */
function expectNothingOutside(buf: ScreenBuffer, rect: { x: number; y: number; width: number; height: number }) {
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      if (inside) continue;
      const cell = buf.get(x, y)!;
      expect({ x, y, ch: cell.ch, fg: cell.fg, bg: cell.bg }).toEqual({ x, y, ch: ' ', fg: null, bg: null });
    }
  }
}

describe('day panel', () => {
  it('shows the day, its models and agents', () => {
    const model = vm();
    const buf = new ScreenBuffer(DAY_PANEL_WIDTH, 12);
    drawDayPanel(buf, { x: 0, y: 0, width: DAY_PANEL_WIDTH, height: 12 }, { day: model.byDate.get(TODAY) ?? null, date: TODAY, theme });
    const text = toPlainText(buf);
    expect(text).toContain('Sat 3 Oct 2026');
    expect(text).toContain('claude-sonnet');
    expect(text).toContain('Claude Code');
  });

  it('says so when the day is empty', () => {
    const buf = new ScreenBuffer(DAY_PANEL_WIDTH, 8);
    drawDayPanel(buf, { x: 0, y: 0, width: DAY_PANEL_WIDTH, height: 8 }, { day: null, date: '2026-01-01', theme });
    expect(toPlainText(buf)).toContain('No tokens this day');
  });

  it('stays inside a narrow rect', () => {
    const model = vm();
    for (const width of [14, 3]) {
      const buf = new ScreenBuffer(40, 16);
      const rect = { x: 3, y: 2, width, height: 12 };
      drawDayPanel(buf, rect, { day: model.byDate.get(TODAY) ?? null, date: TODAY, theme });
      expectNothingOutside(buf, rect);
    }
  });
});
