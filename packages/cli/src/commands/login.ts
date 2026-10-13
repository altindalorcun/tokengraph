import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, pollDeviceToken, requestDeviceCode, type DeviceTokenResponse } from '../api.js';
import { readConfig, resolveApiUrl, writeConfig } from '../config.js';

type Approved = Extract<DeviceTokenResponse, { status: 'approved' }>;

export interface WaitDependencies {
  poll: () => Promise<DeviceTokenResponse>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}

/**
 * Polls until the code is approved or expires. Network hiccups and server errors are
 * retried; anything the server reports about the code itself (used, expired, conflict)
 * is final and thrown.
 */
export async function waitForApproval(
  dependencies: WaitDependencies,
  expiresAt: number,
  intervalSeconds: number,
): Promise<Approved | null> {
  let interval = Math.max(1, intervalSeconds);
  while (dependencies.now() < expiresAt) {
    await dependencies.sleep(interval * 1000);
    try {
      const result = await dependencies.poll();
      if (result.status === 'approved') return result;
      interval = Math.max(1, result.interval);
    } catch (error) {
      const transient = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      if (!transient) throw error;
    }
  }
  return null;
}

function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed as well, so a missing opener is not a failure.
  }
}

/** True for a plain-http server other than this machine: its API key would cross the network unencrypted. */
export function isInsecureApiUrl(apiUrl: string): boolean {
  const url = new URL(apiUrl);
  return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export interface LoginOptions {
  apiUrl?: string;
  newDevice: boolean;
  openBrowser: boolean;
}

export async function runLogin(options: LoginOptions): Promise<number> {
  const config = await readConfig();
  const apiUrl = resolveApiUrl(config, options.apiUrl);
  // Reusing the device ID matters: usage is stored per device and summed, so a fresh ID
  // for the same machine would count its history twice.
  const deviceId = !options.newDevice && config.deviceId ? config.deviceId : randomUUID();
  const label = hostname().slice(0, 60) || undefined;
  if (isInsecureApiUrl(apiUrl)) {
    console.error(`Warning: ${apiUrl} is not https, so this machine's API key will be sent unencrypted.`);
  }

  const start = await requestDeviceCode(apiUrl, deviceId);
  console.log(`\nOpen ${start.verificationUrl}`);
  console.log(`and confirm this code: ${start.code}\n`);
  if (options.openBrowser && process.stdout.isTTY) openInBrowser(start.verificationUrl);
  console.log('Waiting for approval…');

  const approved = await waitForApproval(
    {
      poll: () => pollDeviceToken(apiUrl, { code: start.code, pollToken: start.pollToken, label }),
      sleep,
      now: Date.now,
    },
    Date.parse(start.expiresAt),
    start.interval,
  );
  if (!approved) {
    console.error('The code expired before it was approved. Run `tokengraph login` again.');
    return 1;
  }

  await writeConfig({
    ...config,
    apiUrl,
    apiKey: approved.apiKey,
    deviceId: approved.deviceId,
    username: approved.username ?? undefined,
  });
  console.log(`\nLogged in as ${approved.username ?? 'your account'}. Run \`tokengraph sync\` to upload.`);
  if (config.uploads === false) {
    console.log('Uploads are off on this machine, so nothing will be sent until you run `tokengraph uploads on`.');
  }
  return 0;
}
