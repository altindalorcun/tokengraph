import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCodexRateLimits, readCodexLimits } from '../src/limits/codex.js';

const T = '2026-09-24T19:57:40.652Z';

function tokenCount(rateLimits: unknown, timestamp = T): Record<string, unknown> {
  return { timestamp, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } };
}

const SPEC_LIMITS = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 6.0, window_minutes: 43200, resets_at: 1792696765 },
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: null },
  plan_type: 'free',
  rate_limit_reached_type: null,
};

describe('parseCodexRateLimits', () => {
  it('reads the rate limits of a token_count event', () => {
    expect(parseCodexRateLimits(tokenCount(SPEC_LIMITS))).toEqual({
      source: 'codex-cli',
      limitId: 'codex',
      plan: 'free',
      origin: 'session-log',
      readAt: T,
      credits: { hasCredits: false, unlimited: false, balance: null },
      windows: [{ id: 'primary', minutes: 43200, usedPercent: 6, resetsAt: new Date(1792696765 * 1000).toISOString() }],
    });
  });

  it('takes the reset from resets_in_seconds when resets_at is missing', () => {
    const limits = { ...SPEC_LIMITS, primary: { used_percent: 6, window_minutes: 300, resets_in_seconds: 3600 } };
    expect(parseCodexRateLimits(tokenCount(limits))!.windows[0]!.resetsAt).toBe('2026-09-24T20:57:40.652Z');
  });

  it('reads a secondary window', () => {
    const limits = { ...SPEC_LIMITS, secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1792696765 } };
    expect(parseCodexRateLimits(tokenCount(limits))!.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['primary', 6],
      ['secondary', 12],
    ]);
  });

  it('drops malformed windows and records without throwing', () => {
    const textPercent = { ...SPEC_LIMITS, primary: { used_percent: '6', window_minutes: 300, resets_at: 1792696765 } };
    const noReset = { ...SPEC_LIMITS, primary: { used_percent: 6, window_minutes: 300 } };
    expect(parseCodexRateLimits(tokenCount(textPercent))).toBeNull();
    expect(parseCodexRateLimits(tokenCount(noReset))).toBeNull();
    expect(parseCodexRateLimits(tokenCount(null))).toBeNull();
    expect(parseCodexRateLimits(tokenCount('limits'))).toBeNull();
    expect(parseCodexRateLimits({ timestamp: T, type: 'event_msg' })).toBeNull();
    expect(parseCodexRateLimits(null)).toBeNull();
    expect(parseCodexRateLimits({ ...tokenCount(SPEC_LIMITS), timestamp: 'yesterday' })).toBeNull();
  });

  it('keeps a balance as text and leaves out a missing limit id or plan', () => {
    const limits = { primary: SPEC_LIMITS.primary, credits: { has_credits: true, unlimited: false, balance: 12.5 } };
    const reading = parseCodexRateLimits(tokenCount(limits))!;
    expect(reading.limitId).toBeNull();
    expect(reading.plan).toBeNull();
    expect(reading.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.5' });
  });
});

describe('readCodexLimits', () => {
  let home: string;
  const previous = process.env['CODEX_HOME'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codex-limits-'));
    process.env['CODEX_HOME'] = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previous;
  });

  async function rollout(relative: string, records: unknown[], mtime: Date): Promise<void> {
    const path = join(home, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    await utimes(path, mtime, mtime);
  }

  const percent = (n: number, limitId = 'codex') => ({ ...SPEC_LIMITS, limit_id: limitId, primary: { ...SPEC_LIMITS.primary, used_percent: n } });

  it('returns nothing without a Codex folder', async () => {
    process.env['CODEX_HOME'] = join(home, 'missing');
    expect(await readCodexLimits()).toEqual([]);
  });

  it('takes the newest reading across session files', async () => {
    await rollout('sessions/2026/11/18/rollout-a.jsonl', [tokenCount(percent(6), '2026-11-18T10:00:00Z')], new Date('2026-11-18T10:00:00Z'));
    await rollout('sessions/2026/11/19/rollout-b.jsonl', [tokenCount(percent(20), '2026-11-19T10:00:00Z')], new Date('2026-11-19T10:00:00Z'));
    const readings = await readCodexLimits();
    expect(readings.map((r) => r.windows[0]!.usedPercent)).toEqual([20]);
  });

  it('takes the last event of a file, and a resumed session in an older day folder', async () => {
    await rollout(
      'sessions/2026/11/01/rollout-old.jsonl',
      [tokenCount(percent(30), '2026-11-19T09:00:00Z'), tokenCount(percent(31), '2026-11-19T11:00:00Z')],
      new Date('2026-11-19T11:00:00Z'),
    );
    await rollout('sessions/2026/11/19/rollout-new.jsonl', [tokenCount(percent(25), '2026-11-19T10:00:00Z')], new Date('2026-11-19T10:00:00Z'));
    expect((await readCodexLimits()).map((r) => r.windows[0]!.usedPercent)).toEqual([31]);
  });

  it('keeps one reading per limit id', async () => {
    await rollout('sessions/2026/11/19/rollout-a.jsonl', [tokenCount(percent(6)), tokenCount(percent(40, 'codex_mini'))], new Date());
    expect((await readCodexLimits()).map((r) => r.limitId).sort()).toEqual(['codex', 'codex_mini']);
  });

  it('reads archived sessions too', async () => {
    await rollout('sessions/2026/11/18/rollout-a.jsonl', [tokenCount(percent(6), '2026-11-18T10:00:00Z')], new Date('2026-11-18T10:00:00Z'));
    await rollout('archived_sessions/rollout-z.jsonl', [tokenCount(percent(50), '2026-11-19T10:00:00Z')], new Date('2026-11-19T10:00:00Z'));
    expect((await readCodexLimits()).map((r) => r.windows[0]!.usedPercent)).toEqual([50]);
  });
});
