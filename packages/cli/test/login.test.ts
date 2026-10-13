import { describe, expect, it } from 'vitest';
import { ApiError, type DeviceTokenResponse } from '../src/api.js';
import { isInsecureApiUrl, waitForApproval } from '../src/commands/login.js';

describe('isInsecureApiUrl', () => {
  it('flags plain http to another machine only', () => {
    expect(isInsecureApiUrl('http://example.com')).toBe(true);
    expect(isInsecureApiUrl('https://example.com')).toBe(false);
    expect(isInsecureApiUrl('http://localhost:3000')).toBe(false);
    expect(isInsecureApiUrl('http://127.0.0.1:3000')).toBe(false);
    expect(isInsecureApiUrl('http://[::1]:3000')).toBe(false);
  });
});

const APPROVED: DeviceTokenResponse = {
  status: 'approved',
  apiKey: 'tg_key',
  username: 'someone',
  deviceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
};

function harness(responses: Array<DeviceTokenResponse | Error>) {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    dependencies: {
      poll: async () => {
        const next = responses.shift();
        if (!next) throw new Error('polled too many times');
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  };
}

describe('waitForApproval', () => {
  it('keeps polling while pending and returns the approval', async () => {
    const { dependencies, sleeps } = harness([
      { status: 'pending', interval: 3 },
      { status: 'pending', interval: 5 },
      APPROVED,
    ]);
    expect(await waitForApproval(dependencies, 60_000, 3)).toEqual(APPROVED);
    // Honours the interval the server asks for.
    expect(sleeps).toEqual([3000, 3000, 5000]);
  });

  it('gives up once the code expires', async () => {
    const { dependencies } = harness(Array.from({ length: 10 }, () => ({ status: 'pending', interval: 3 }) as const));
    expect(await waitForApproval(dependencies, 9_000, 3)).toBeNull();
  });

  it('retries through network errors and server failures', async () => {
    const { dependencies } = harness([
      new ApiError(0, 'network_error', 'offline'),
      new ApiError(502, 'http_error', 'bad gateway'),
      APPROVED,
    ]);
    expect(await waitForApproval(dependencies, 60_000, 3)).toEqual(APPROVED);
  });

  it('stops immediately on a final answer about the code', async () => {
    const { dependencies } = harness([new ApiError(410, 'already_used', 'used')]);
    await expect(waitForApproval(dependencies, 60_000, 3)).rejects.toMatchObject({ code: 'already_used' });
  });
});
