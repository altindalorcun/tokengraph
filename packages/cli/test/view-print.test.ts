import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeHours, mergeUsage } from '../src/ledger.js';
import { buildViewModel, shiftDate } from '../src/tui/model.js';
import { cachedMachines, printWidth } from '../src/commands/view.js';
import { machinesLine } from '../src/tui/machines.js';
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

describe('printWidth', () => {
  it('takes the terminal width, then $COLUMNS for a pipe, then 100', () => {
    expect(printWidth(132, '80')).toBe(132);
    expect(printWidth(undefined, '80')).toBe(80);
    expect(printWidth(undefined, 'wide')).toBe(100);
    expect(printWidth(undefined, undefined)).toBe(100);
  });
});

describe('other machines in the snapshot', () => {
  const remote = mergeUsage(emptyLedger(), 'claude-code', [{ date: TODAY, model: 'claude-sonnet-4-5', pricingTier: 'standard', counts: c(9000) }]);
  const file = { schema: 1 as const, machineId: 'aaaaaaaa-0000-0000-0000-000000000001', label: 'linux-aaaaaa', fingerprint: 'f', cliVersion: '1.0.0', updatedAt: `${TODAY}T10:00:00.000Z`, sources: remote.sources };

  it('prints the machines line under the mode and marks the busiest hour as this machine', () => {
    let local = mergeUsage(emptyLedger(), 'codex-cli', [{ date: TODAY, model: 'gpt-5', pricingTier: 'standard', counts: c(1000) }]);
    local = mergeHours(local, 'codex-cli', [{ date: TODAY, hour: 9, weighted: 1000 }]);
    const out = renderSnapshot(buildViewModel(local, TODAY, { others: [file] }), {
      width: 100, theme: 'dark', depth: 'none', mode: 'local only',
      machines: machinesLine({ count: 1, publishedAt: `${TODAY}T10:00:00.000Z` }, 'all', Date.parse(`${TODAY}T12:00:00.000Z`)),
    });
    expect(out.split('\n')[1]).toMatch(/2 machines · others as of 2h ago$/);
    expect(out).toContain('Sonnet');
    expect(out).toContain('(this machine, hour data from');
  });

  it('reads the cache only while logged in', async () => {
    const files = async () => [file];
    const publishedAt = async () => `${TODAY}T10:00:00.000Z`;
    expect(await cachedMachines({ config: async () => ({}) as never, files, publishedAt })).toEqual({ files: [], publishedAt: null });
    const loggedIn = async () => ({ github: { login: 'someone', auth: { kind: 'gh' } } }) as never;
    expect(await cachedMachines({ config: loggedIn, files, publishedAt })).toEqual({ files: [file], publishedAt: `${TODAY}T10:00:00.000Z` });
  });
});
