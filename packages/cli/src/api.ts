import type { UsagePayload } from '@tokengraph/core';
import type { SyncTrigger } from './commands/sync.js';

const TIMEOUT_MS = 15_000;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new ApiError(0, 'network_error', `Could not reach ${new URL(url).origin}${cause ? ` (${cause})` : ''}.`);
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON bodies (e.g. a proxy error page) fall through to the generic message.
  }
  if (!response.ok) {
    const fields = (body ?? {}) as { error?: unknown; message?: unknown };
    throw new ApiError(
      response.status,
      typeof fields.error === 'string' ? fields.error : 'http_error',
      typeof fields.message === 'string' ? fields.message : `Request failed with HTTP ${response.status}.`,
    );
  }
  return body as T;
}

export interface DeviceCodeResponse {
  code: string;
  pollToken: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

export type DeviceTokenResponse =
  | { status: 'pending'; interval: number }
  | { status: 'approved'; apiKey: string; username: string | null; deviceId: string };

export function requestDeviceCode(apiUrl: string, deviceId: string): Promise<DeviceCodeResponse> {
  return call(`${apiUrl}/api/v1/device/code`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ deviceId }),
  });
}

export function pollDeviceToken(
  apiUrl: string,
  request: { code: string; pollToken: string; label?: string },
): Promise<DeviceTokenResponse> {
  return call(`${apiUrl}/api/v1/device/token`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

export function uploadUsage(
  apiUrl: string,
  apiKey: string,
  payload: UsagePayload,
  trigger: SyncTrigger = 'manual',
): Promise<{ ok: true; days: number; rows: number }> {
  return call(`${apiUrl}/api/v1/usage`, {
    method: 'PUT',
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${apiKey}`, 'X-Token-Graph-Trigger': trigger },
    body: JSON.stringify(payload),
  });
}
