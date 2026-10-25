import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeHours, mergeUsage } from '../src/ledger.js';
import { buildViewModel, shiftDate } from '../src/tui/model.js';
import { renderSnapshot } from '../src/tui/print.js';

const TODAY = '2026-10-03';
const c = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });

describe('renderSnapshot', () => {
  const vm = (() => {
    let ledger = emptyLedger();
    for (let i = 0; i < 30; i += 1) {
      ledger = mergeUsage(ledger, 'codex-cli', [{ date: shiftDate(TODAY, -i), model: 'gpt-5', pricingTier: 'standard', counts: c(2000 * (i + 1)) }]);
    }
    return buildViewModel(ledger, TODAY);
  })();

  for (const width of [120, 80]) {
    it(`fits ${width} columns without colour`, () => {
      const out = renderSnapshot(vm, { width, theme: 'dark', depth: 'none', mode: 'local only' });
      const lines = out.split('\n');
      expect(lines.every((line) => line.length <= width)).toBe(true);
      expect(out).toContain('tokengraph');
      expect(out).toContain('TODAY');
      expect(out).toContain('gpt-5');
      expect(out).not.toContain('\x1b');
    });
  }

  it('shows the same five tiles and never cuts the cost detail mid-word', () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 30; i += 1) {
      ledger = mergeUsage(ledger, 'codex-cli', [{ date: shiftDate(TODAY, -i), model: 'gpt-5.5', pricingTier: 'standard', counts: c(2_000_000) }]);
    }
    ledger = mergeUsage(ledger, 'codex-cli', [{ date: TODAY, model: 'mystery-model-9', pricingTier: 'standard', counts: c(1000) }]);
    const out = renderSnapshot(buildViewModel(ledger, TODAY), { width: 100, theme: 'dark', depth: 'none', mode: 'local only' });
    for (const title of ['TODAY', 'THIS WEEK', 'STREAK', 'EST. COST', 'CACHE SAVED']) expect(out).toContain(title);
    expect(out).not.toMatch(/cache hit/i);
    expect(out).not.toMatch(/\+ unp(?!riced)/);
  });

  it('uses ANSI colour when asked', () => {
    expect(renderSnapshot(vm, { width: 120, theme: 'dark', depth: 'truecolor', mode: 'local only' })).toContain('\x1b[');
  });

  it('prints the busiest hour with its share and the first day of hour data', () => {
    let ledger = emptyLedger();
    ledger = mergeUsage(ledger, 'codex-cli', [{ date: TODAY, model: 'gpt-5', pricingTier: 'standard', counts: c(1000) }]);
    ledger = mergeHours(ledger, 'codex-cli', [
      { date: '2026-10-02', hour: 22, weighted: 180 },
      { date: '2026-10-03', hour: 9, weighted: 820 },
    ]);
    const out = renderSnapshot(buildViewModel(ledger, TODAY), { width: 100, theme: 'dark', depth: 'none', mode: 'local only' });
    expect(out).toContain('Busiest hour');
    expect(out).toContain('09:00–10:00 · 82% of tokens (hour data from 2 Oct 2026)');
    expect(out.split('\n').every((line) => line.length <= 100)).toBe(true);
  });

  it('says there is no hour data yet when no adapter has reported any', () => {
    expect(renderSnapshot(vm, { width: 80, theme: 'dark', depth: 'none', mode: 'local only' })).toContain('Busiest hour no hour data yet');
  });
});
