import { limitViews, type LimitReading } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { STILL } from '../../src/tui/animate.js';
import { emptyLedger, mergeUsage } from '../../src/ledger.js';
import { buildViewModel } from '../../src/tui/model.js';
import { ScreenBuffer, toPlainText } from '../../src/tui/screen.js';
import { tuiTheme } from '../../src/tui/theme.js';
import { drawLimits, limitsBlockHeight } from '../../src/tui/views/limits.js';
import { drawOverview } from '../../src/tui/views/overview.js';

const TODAY = '2026-11-19';
const NOW = new Date('2026-11-19T12:00:00Z');
const theme = tuiTheme('dark');

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
  credits: null,
  windows: [{ id: 'primary', minutes: 43200, usedPercent: 6, resetsAt: '2026-12-15T12:00:00.000Z' }],
};

function vm() {
  const counts = { inputTokens: 5000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };
  return buildViewModel(mergeUsage(emptyLedger(), 'claude-code', [{ date: TODAY, model: 'claude-sonnet-4-5', pricingTier: 'standard', counts }]), TODAY);
}

function draw(width: number, readings: LimitReading[], wrapperOn: boolean | null = true) {
  const views = limitViews(readings, NOW);
  const height = limitsBlockHeight(views, wrapperOn);
  const buf = new ScreenBuffer(width, Math.max(1, height));
  const result = drawLimits(buf, { x: 0, y: 0, width, height }, { vm: vm(), theme, motion: STILL, colorMode: 'per-model', views, wrapperOn });
  return { buf, text: toPlainText(buf), result };
}

describe('drawLimits', () => {
  it('shows each window with its bar, share, reset time and the age of the reading', () => {
    const { text } = draw(100, [CLAUDE]);
    for (const part of ['LIMITS', 'Claude Code', '5h', ' 58%', 'resets in 1h 12m', '3m ago', '7d', ' 21%']) expect(text).toContain(part);
    expect(text).toContain('█');
  });

  it('drops the age, then the reset time, then the bar as the width shrinks', () => {
    expect(draw(50, [CLAUDE]).text).not.toContain('ago');
    const narrow = draw(34, [CLAUDE]).text;
    expect(narrow).not.toContain('resets');
    expect(narrow).not.toContain('█');
    expect(narrow).toContain(' 58%');
  });

  it('shows a window that has reset without a share or a bar', () => {
    const stale = { ...CLAUDE, windows: [{ ...CLAUDE.windows[0]!, resetsAt: '2026-11-19T11:00:00.000Z' }] };
    const { text } = draw(100, [stale]);
    expect(text).toContain('reset · no reading since');
    expect(text).not.toContain('█');
    expect(text).not.toContain('%');
  });

  it('colours the bar by level', () => {
    const full = { ...CLAUDE, windows: [{ ...CLAUDE.windows[0]!, usedPercent: 91 }] };
    const { buf } = draw(100, [full]);
    let bar: string | null = null;
    for (let x = 0; x < buf.width && bar === null; x += 1) if (buf.get(x, 1)?.ch === '█') bar = buf.get(x, 1)!.fg;
    expect(bar).toBe(theme.bad);
  });

  it('points to Setup when Claude Code has no reading and the wrapper is off', () => {
    const off = draw(100, [CODEX], false);
    expect(off.text).toContain('no reading · turn on in Setup');
    expect(off.text).toContain('Codex · free');
    expect(off.result.hits).toEqual([expect.objectContaining({ kind: 'action', id: 'claude-limits' })]);
    const on = draw(100, [CODEX], true);
    expect(on.text).toContain('no reading yet');
    expect(on.result.hits).toEqual([]);
  });

  it('takes one title row, one row per window and one for a missing Claude Code reading', () => {
    expect(limitsBlockHeight(limitViews([CLAUDE, CODEX], NOW), true)).toBe(4);
    expect(limitsBlockHeight([], true)).toBe(2);
    expect(limitsBlockHeight([], false)).toBe(2);
    expect(limitsBlockHeight([], null)).toBe(0);
  });
});

describe('overview with limits', () => {
  const props = (views = limitViews([CLAUDE], NOW)) => ({
    vm: vm(),
    theme,
    motion: STILL,
    colorMode: 'per-model' as const,
    state: { cursor: TODAY, yearEnd: TODAY },
    limits: { views, wrapperOn: true },
  });

  it('puts the block between the heatmap and the chart when there is room', () => {
    const buf = new ScreenBuffer(160, 40);
    drawOverview(buf, { x: 0, y: 0, width: 160, height: 40 }, props());
    const text = toPlainText(buf);
    expect(text).toContain('LIMITS');
    expect(text).toContain('LAST 30 DAYS');
    expect(text.indexOf('LIMITS')).toBeLessThan(text.indexOf('LAST 30 DAYS'));
  });

  it('leaves the block out rather than squeeze the chart', () => {
    const buf = new ScreenBuffer(160, 24);
    drawOverview(buf, { x: 0, y: 0, width: 160, height: 24 }, props());
    const text = toPlainText(buf);
    expect(text).not.toContain('LIMITS');
    expect(text).toContain('LAST 30 DAYS');
  });
});
