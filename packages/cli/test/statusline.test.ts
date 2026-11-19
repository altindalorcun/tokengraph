import type { LimitReading } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { claudeReadingFromStatusline, isTokenGraphStatuslineCommand, runStatusline, type StatuslineDeps } from '../src/commands/statusline.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const OURS = '"/usr/local/bin/node" "/usr/local/lib/node_modules/tokengraph/bundle/bin.js" statusline';
const node = (script: string) => `"${process.execPath}" -e "${script}"`;

const INPUT = {
  model: { display_name: 'Opus' },
  rate_limits: { five_hour: { used_percentage: 58.4, resets_at: 1795000000 }, seven_day: { used_percentage: 21, resets_at: 1795400000 } },
};

function harness(stdin: string | Buffer, over: Partial<StatuslineDeps> = {}) {
  const written: Buffer[] = [];
  const stored: LimitReading[] = [];
  let spawned = 0;
  const deps: Partial<StatuslineDeps> = {
    stdin: async () => (typeof stdin === 'string' ? Buffer.from(stdin) : stdin),
    now: () => NOW,
    previous: () => null,
    store: async (reading) => {
      stored.push(reading);
      return true;
    },
    write: (bytes) => written.push(bytes),
    ...over,
  };
  if (over.spawnShell) {
    const inner = over.spawnShell;
    deps.spawnShell = (command, input) => {
      spawned += 1;
      return inner(command, input);
    };
  }
  return { deps, written: () => Buffer.concat(written), stored, spawned: () => spawned };
}

describe('claudeReadingFromStatusline', () => {
  it('reads the five-hour and seven-day windows', () => {
    expect(claudeReadingFromStatusline(INPUT, NOW)).toEqual({
      source: 'claude-code',
      limitId: null,
      plan: null,
      origin: 'statusline',
      readAt: NOW.toISOString(),
      credits: null,
      windows: [
        { id: 'five_hour', minutes: 300, usedPercent: 58.4, resetsAt: new Date(1795000000 * 1000).toISOString() },
        { id: 'seven_day', minutes: 10080, usedPercent: 21, resetsAt: new Date(1795400000 * 1000).toISOString() },
      ],
    });
  });

  it('takes other windows of the same shape with an unknown length', () => {
    const input = { rate_limits: { seven_day_opus: { used_percentage: 5, resets_at: 1795400000 } } };
    expect(claudeReadingFromStatusline(input, NOW)!.windows).toEqual([
      { id: 'seven_day_opus', minutes: null, usedPercent: 5, resetsAt: new Date(1795400000 * 1000).toISOString() },
    ]);
  });

  it('skips malformed windows and input without limits', () => {
    expect(claudeReadingFromStatusline({ model: {} }, NOW)).toBeNull();
    expect(claudeReadingFromStatusline({ rate_limits: { five_hour: { used_percentage: '58', resets_at: 1795000000 } } }, NOW)).toBeNull();
    expect(claudeReadingFromStatusline({ rate_limits: { five_hour: { used_percentage: 58, resets_at: '1795000000' } } }, NOW)).toBeNull();
    expect(claudeReadingFromStatusline({ rate_limits: { five_hour: null, seven_day: 3 } }, NOW)).toBeNull();
    expect(claudeReadingFromStatusline({ rate_limits: 'x' }, NOW)).toBeNull();
    expect(claudeReadingFromStatusline(null, NOW)).toBeNull();
  });
});

describe('isTokenGraphStatuslineCommand', () => {
  it('recognises our command and nothing else', () => {
    expect(isTokenGraphStatuslineCommand(OURS)).toBe(true);
    expect(isTokenGraphStatuslineCommand('"C:\\node.exe" "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\tokengraph\\bundle\\bin.js" statusline')).toBe(true);
    expect(isTokenGraphStatuslineCommand('bash ~/.claude/statusline-command.sh')).toBe(false);
    expect(isTokenGraphStatuslineCommand('"/usr/bin/node" "/opt/other/bin.js" statusline')).toBe(false);
    expect(isTokenGraphStatuslineCommand(`${OURS} && rm -rf /`)).toBe(false);
  });
});

describe('runStatusline', () => {
  it('stores the reading and prints nothing without a previous command', async () => {
    const h = harness(JSON.stringify(INPUT));
    expect(await runStatusline(h.deps)).toBe(0);
    expect(h.written().length).toBe(0);
    expect(h.stored.map((r) => r.windows.length)).toEqual([2]);
  });

  it('passes the previous command its stdin and prints its bytes unchanged', async () => {
    const stdin = Buffer.from('\x1b[36mA\x1b[0m\nB');
    const h = harness(stdin, { previous: () => ({ type: 'command', command: node('process.stdin.pipe(process.stdout)'), padding: 0 }) });
    expect(await runStatusline(h.deps)).toBe(0);
    expect(h.written().equals(stdin)).toBe(true);
  });

  it("returns the previous command's exit code", async () => {
    const h = harness('{}', { previous: () => ({ type: 'command', command: node('process.exit(3)') }) });
    expect(await runStatusline(h.deps)).toBe(3);
  });

  it('never chains to our own command', async () => {
    const h = harness('{}', { previous: () => ({ type: 'command', command: OURS }), spawnShell: async () => ({ stdout: Buffer.from('loop'), code: 0 }) });
    expect(await runStatusline(h.deps)).toBe(0);
    expect(h.spawned()).toBe(0);
    expect(h.written().length).toBe(0);
  });

  it('still chains when the input is not JSON or the store fails', async () => {
    const echo = { type: 'command', command: node("process.stdout.write('line')") };
    const garbage = harness('not json', { previous: () => echo });
    expect(await runStatusline(garbage.deps)).toBe(0);
    expect(garbage.written().toString()).toBe('line');
    expect(garbage.stored).toEqual([]);

    const failing = harness(JSON.stringify(INPUT), {
      previous: () => echo,
      store: async () => {
        throw new Error('disk full');
      },
    });
    expect(await runStatusline(failing.deps)).toBe(0);
    expect(failing.written().toString()).toBe('line');
  });
});
