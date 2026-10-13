import { describe, expect, it } from 'vitest';
import { DeviceFlowError, GITHUB_CLIENT_ID, pollForToken, requestDeviceCode, type DeviceCode } from '../src/github/device-flow.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sequence(bodies: unknown[]) {
  const calls: { url: string; body: string }[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: String(init.body) });
    return json(bodies[Math.min(calls.length - 1, bodies.length - 1)]);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const code: DeviceCode = { deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };

function clock() {
  let now = 0;
  const slept: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; }, slept };
}

describe('requestDeviceCode', () => {
  it('asks for the gist scope with the public client id', async () => {
    const { fetch, calls } = sequence([{ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }]);
    expect(await requestDeviceCode({ fetch, webBase: 'https://gh.test' })).toEqual(code);
    expect(calls[0]!.url).toBe('https://gh.test/login/device/code');
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('client_id')).toBe(GITHUB_CLIENT_ID);
    expect(params.get('scope')).toBe('gist');
  });

  it('explains a disabled device flow', async () => {
    const { fetch } = sequence([{ error: 'device_flow_disabled' }]);
    await expect(requestDeviceCode({ fetch })).rejects.toMatchObject({ reason: 'disabled' });
  });
});

describe('pollForToken', () => {
  it('waits while pending and returns the token', async () => {
    const { fetch, calls } = sequence([{ error: 'authorization_pending' }, { access_token: 'gho_x', token_type: 'bearer', scope: 'gist' }]);
    const time = clock();
    expect(await pollForToken(code, { fetch, ...time })).toEqual({ accessToken: 'gho_x', scopes: ['gist'] });
    expect(time.slept).toEqual([5000, 5000]);
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(params.get('device_code')).toBe('dev');
    expect(params.has('client_secret')).toBe(false);
  });

  it('slows down when asked', async () => {
    const { fetch } = sequence([{ error: 'slow_down', interval: 10 }, { error: 'slow_down' }, { access_token: 'gho_x', scope: 'gist' }]);
    const time = clock();
    await pollForToken(code, { fetch, ...time });
    expect(time.slept).toEqual([5000, 10000, 15000]);
  });

  it('never polls faster than once a second', async () => {
    const zero = clock();
    await pollForToken({ ...code, interval: 0 }, { fetch: sequence([{ access_token: 'gho_x', scope: 'gist' }]).fetch, ...zero });
    expect(zero.slept).toEqual([1000]);
  });

  it('never lowers the interval on slow_down', async () => {
    const time = clock();
    await pollForToken(code, { fetch: sequence([{ error: 'slow_down', interval: 2 }, { access_token: 'gho_x', scope: 'gist' }]).fetch, ...time });
    expect(time.slept).toEqual([5000, 5000]);
  });

  it('stops on denial and on expiry', async () => {
    await expect(pollForToken(code, { fetch: sequence([{ error: 'access_denied' }]).fetch, ...clock() })).rejects.toMatchObject({ reason: 'denied' });
    await expect(pollForToken(code, { fetch: sequence([{ error: 'expired_token' }]).fetch, ...clock() })).rejects.toMatchObject({ reason: 'expired' });
    const short = { ...code, expiresIn: 12 };
    await expect(pollForToken(short, { fetch: sequence([{ error: 'authorization_pending' }]).fetch, ...clock() })).rejects.toBeInstanceOf(DeviceFlowError);
  });
});
