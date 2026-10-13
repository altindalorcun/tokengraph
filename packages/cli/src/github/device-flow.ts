import { githubWebBase } from './http.js';

/** The public "tokengraph" OAuth App. Device flow needs no client secret, and none exists. */
export const GITHUB_CLIENT_ID = 'Ov23liunAdVeHoVD4vgm';
/** Write access to gists and nothing else. */
export const GITHUB_SCOPE = 'gist';

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
}

export type DeviceFlowFailure = 'expired' | 'denied' | 'disabled' | 'failed';

const MESSAGES: Record<DeviceFlowFailure, string> = {
  expired: 'The code expired before it was approved. Run `tokengraph login` again.',
  denied: 'The request was cancelled on GitHub.',
  disabled: 'GitHub refused the device flow for this app. Please report this at https://github.com/altindalorcun/tokengraph/issues',
  failed: 'GitHub could not complete the login.',
};

export class DeviceFlowError extends Error {
  constructor(
    readonly reason: DeviceFlowFailure,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[reason]} (${detail})` : MESSAGES[reason]);
    this.name = 'DeviceFlowError';
  }
}

export interface DeviceFlowDeps {
  fetch?: typeof fetch;
  webBase?: string;
  clientId?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function post(deps: DeviceFlowDeps, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const doFetch = deps.fetch ?? fetch;
  const base = (deps.webBase ?? githubWebBase()).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (error) {
    throw new DeviceFlowError('failed', error instanceof Error ? error.message : String(error));
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new DeviceFlowError('failed', `HTTP ${response.status}`);
  }
}

function failureFor(error: unknown): DeviceFlowError {
  if (error === 'expired_token') return new DeviceFlowError('expired');
  if (error === 'access_denied') return new DeviceFlowError('denied');
  if (error === 'device_flow_disabled') return new DeviceFlowError('disabled');
  return new DeviceFlowError('failed', typeof error === 'string' ? error : undefined);
}

export async function requestDeviceCode(deps: DeviceFlowDeps = {}): Promise<DeviceCode> {
  const body = await post(deps, '/login/device/code', { client_id: deps.clientId ?? GITHUB_CLIENT_ID, scope: GITHUB_SCOPE });
  if (typeof body['device_code'] !== 'string' || typeof body['user_code'] !== 'string') throw failureFor(body['error']);
  return {
    deviceCode: body['device_code'],
    userCode: body['user_code'],
    verificationUri: typeof body['verification_uri'] === 'string' ? body['verification_uri'] : 'https://github.com/login/device',
    expiresIn: typeof body['expires_in'] === 'number' ? body['expires_in'] : 900,
    interval: typeof body['interval'] === 'number' ? body['interval'] : 5,
  };
}

export async function pollForToken(code: DeviceCode, deps: DeviceFlowDeps = {}): Promise<{ accessToken: string; scopes: string[] }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = Math.max(1, code.interval);
  while (now() < deadline) {
    await sleep(interval * 1000);
    const body = await post(deps, '/login/oauth/access_token', {
      client_id: deps.clientId ?? GITHUB_CLIENT_ID,
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof body['access_token'] === 'string') {
      const scope = typeof body['scope'] === 'string' ? body['scope'] : '';
      return { accessToken: body['access_token'], scopes: scope.split(/[,\s]+/).filter(Boolean) };
    }
    if (body['error'] === 'authorization_pending') continue;
    if (body['error'] === 'slow_down') {
      // Only ever slower: a server interval below ours is ignored.
      interval = typeof body['interval'] === 'number' ? Math.max(interval, body['interval']) : interval + 5;
      continue;
    }
    throw failureFor(body['error']);
  }
  throw new DeviceFlowError('expired');
}
