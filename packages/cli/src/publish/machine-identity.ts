import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { promisify } from 'node:util';

export interface IdentityDeps {
  platform: NodeJS.Platform;
  exec: (file: string, args: string[]) => Promise<{ stdout: string }>;
  readFile: (path: string) => Promise<string>;
  hostname: () => string;
  username: () => string;
}

const DEFAULTS: IdentityDeps = {
  platform: process.platform,
  exec: async (file, args) => ({ stdout: String((await promisify(execFile)(file, args, { timeout: 5000, windowsHide: true })).stdout) }),
  readFile: (path) => readFile(path, 'utf8'),
  hostname,
  username: () => {
    try {
      return userInfo().username;
    } catch {
      return process.env['USER'] ?? process.env['USERNAME'] ?? '';
    }
  },
};

/** The OS's own stable machine id. Hostnames are not stable on macOS (they follow the network). */
export async function osMachineId(overrides: Partial<IdentityDeps> = {}): Promise<string | null> {
  const deps = { ...DEFAULTS, ...overrides };
  try {
    if (deps.platform === 'darwin') {
      const { stdout } = await deps.exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1] ?? null;
    }
    if (deps.platform === 'win32') {
      const { stdout } = await deps.exec('reg', ['query', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1] ?? null;
    }
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = (await deps.readFile(path)).trim();
        if (id) return id;
      } catch {
        // try the next one
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function machineFingerprint(rawMachineId: string, username: string): string {
  return createHash('sha256').update(`tokengraph:${rawMachineId}:${username}`).digest('hex');
}

export async function currentFingerprint(overrides: Partial<IdentityDeps> = {}): Promise<string> {
  const deps = { ...DEFAULTS, ...overrides };
  const id = (await osMachineId(deps)) ?? deps.hostname();
  return machineFingerprint(id, deps.username());
}
