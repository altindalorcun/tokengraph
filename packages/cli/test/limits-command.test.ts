import type { LimitReading } from '@tokengraph/core';
import { limitViews } from '@tokengraph/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as collect from '../src/collect-local.js';
import { buildLimitsJson, durationText, limitAgentKey, limitRows, runLimits, type LimitsDeps } from '../src/commands/limits.js';
import { emptyLedger, mergeUsage } from '../src/ledger.js';

const NOW = new Date('2026-11-19T12:00:00Z');

const CLAUDE: LimitReading = {
  source: 'claude-code',
  limitId: null,
  plan: null,
  origin: 'statusline',
  readAt: '2026-11-19T11:57:00.000Z',
  credits: null,
  windows: [
    { id: 'five_hour', minutes: 300, usedPercent: 58, resetsAt: '2026-11-19T13:12:00.000Z' },
    { id: 'seven_day', minutes: 10080, usedPercent: 21, resetsAt: '2026-11-23T14:00:00.000Z' },
  ],
};
const CODEX: LimitReading = {
  source: 'codex-cli',
  limitId: 'codex',
  plan: 'free',
  origin: 'session-log',
  readAt: '2026-11-19T10:00:00.000Z',
  credits: { hasCredits: false, unlimited: false, balance: null },
  windows: [{ id: 'primary', minutes: 43200, usedPercent: 6, resetsAt: '2026-12-15T12:00:00.000Z' }],
};

function ledgerWithToday() {
  const counts = { inputTokens: 1_234_567, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };
  return mergeUsage(emptyLedger(), 'claude-code', [{ date: '2026-11-19', model: 'claude-opus-5-5', pricingTier: 'standard', counts }]);
}

function deps(over: Partial<LimitsDeps> = {}): Partial<LimitsDeps> {
  return {
    now: () => NOW,
    today: () => '2026-11-19',
    claude: async () => CLAUDE,
    codex: async () => [CODEX],
    ledger: async () => ledgerWithToday(),
    ledgerUpdatedAt: async () => '2026-11-19T11:58:10.000Z',
    wrapperOn: async () => true,
    ...over,
  };
}

describe('buildLimitsJson', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows the schema 1 contract', async () => {
    const json = await buildLimitsJson(deps());
    expect(json.schema).toBe(1);
    expect(json.generatedAt).toBe(NOW.toISOString());
    expect(json.today).toMatchObject({ date: '2026-11-19', weightedTokens: 1_234_567, ledgerUpdatedAt: '2026-11-19T11:58:10.000Z' });
    expect(json.today.costUsd).toBeGreaterThan(0);
    expect(Number.isInteger(Math.round(json.today.costUsd * 100))).toBe(true);
    expect(json.limits).toEqual([
      {
        source: 'claude-code',
        limitId: null,
        plan: null,
        origin: 'statusline',
        readAt: '2026-11-19T11:57:00.000Z',
        credits: null,
        windows: [
          { id: 'five_hour', label: '5h', minutes: 300, usedPercent: 58, resetsAt: '2026-11-19T13:12:00.000Z', reset: false },
          { id: 'seven_day', label: '7d', minutes: 10080, usedPercent: 21, resetsAt: '2026-11-23T14:00:00.000Z', reset: false },
        ],
      },
      {
        source: 'codex',
        limitId: 'codex',
        plan: 'free',
        origin: 'session-log',
        readAt: '2026-11-19T10:00:00.000Z',
        credits: null,
        windows: [{ id: 'primary', label: '30d', minutes: 43200, usedPercent: 6, resetsAt: '2026-12-15T12:00:00.000Z', reset: false }],
      },
    ]);
  });

  it('gives a reset window no percentage', async () => {
    const stale = { ...CLAUDE, windows: [{ ...CLAUDE.windows[0]!, resetsAt: '2026-11-19T11:00:00.000Z' }] };
    const json = await buildLimitsJson(deps({ claude: async () => stale, codex: async () => [] }));
    expect(json.limits[0]!.windows[0]).toMatchObject({ usedPercent: null, reset: true });
  });

  it('is empty without readings and with an empty ledger', async () => {
    const json = await buildLimitsJson(deps({ claude: async () => null, codex: async () => [], ledger: async () => emptyLedger(), ledgerUpdatedAt: async () => null }));
    expect(json.limits).toEqual([]);
    expect(json.today).toEqual({ date: '2026-11-19', weightedTokens: 0, costUsd: 0, ledgerUpdatedAt: null });
  });

  it('adapters are never called', async () => {
    const spy = vi.spyOn(collect, 'collectLocal');
    await buildLimitsJson(deps());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('limit text', () => {
  it('formats durations with the two largest units', () => {
    expect(durationText(4 * 86_400_000 + 2 * 3_600_000 + 5 * 60_000)).toBe('4d 2h');
    expect(durationText(72 * 60_000)).toBe('1h 12m');
    expect(durationText(3 * 60_000)).toBe('3m');
    expect(durationText(20_000)).toBe('<1m');
  });

  it('maps sources to public agent keys', () => {
    expect(limitAgentKey('codex-cli')).toBe('codex');
    expect(limitAgentKey('claude-code')).toBe('claude-code');
  });

  it('prints one row per window, the name and age on the first', () => {
    const rows = limitRows(limitViews([CLAUDE, CODEX], NOW), true);
    expect(rows).toEqual([
      'Claude Code   5h   58%  resets in 1h 12m  · 3m ago',
      '              7d   21%  resets in 4d 2h',
      'Codex · free  30d   6%  resets in 26d     · 2h ago',
    ]);
  });

  it('shows a reset window without a percentage', () => {
    const stale = { ...CLAUDE, windows: [{ ...CLAUDE.windows[0]!, resetsAt: '2026-11-19T11:00:00.000Z' }] };
    expect(limitRows(limitViews([stale], NOW), true)).toEqual(['Claude Code  5h  reset · no reading since  · 3m ago']);
  });

  it('says how to get a Claude Code reading', () => {
    const codexOnly = limitViews([CODEX], NOW);
    expect(limitRows(codexOnly, false)[0]).toBe('Claude Code   no reading · run tokengraph limits on');
    expect(limitRows(codexOnly, true)[0]).toBe('Claude Code   no reading yet');
    expect(limitRows([], null)).toEqual(['Claude Code  no reading · run tokengraph limits on']);
  });

  it('shows credits when there are some', () => {
    const rich = { ...CODEX, credits: { hasCredits: true, unlimited: false, balance: '12.5' } };
    expect(limitRows(limitViews([rich], NOW), true)).toContain('              credits 12.5');
  });
});

describe('runLimits', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects an unknown argument', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runLimits(['bogus'], { json: false }, deps())).toBe(1);
  });

  it('prints the JSON contract', async () => {
    let out = '';
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void (out += String(line)));
    expect(await runLimits([], { json: true }, deps())).toBe(0);
    expect(JSON.parse(out).schema).toBe(1);
  });
});
