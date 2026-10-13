import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeUsage } from '../src/ledger.js';
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

  it('uses ANSI colour when asked', () => {
    expect(renderSnapshot(vm, { width: 120, theme: 'dark', depth: 'truecolor', mode: 'local only' })).toContain('\x1b[');
  });
});
