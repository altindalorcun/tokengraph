import { describe, expect, it } from 'vitest';
import { currentFingerprint, machineFingerprint, osMachineId } from '../src/publish/machine-identity.js';

const fail = async () => {
  throw new Error('nope');
};

describe('osMachineId', () => {
  it('reads IOPlatformUUID on macOS', async () => {
    const stdout = '  "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n';
    expect(await osMachineId({ platform: 'darwin', exec: async () => ({ stdout }) })).toBe('ABCDEF01-2345-6789-ABCD-EF0123456789');
  });

  it('reads /etc/machine-id on Linux', async () => {
    expect(await osMachineId({ platform: 'linux', readFile: async (path) => (path === '/etc/machine-id' ? 'abc123\n' : fail()) })).toBe('abc123');
  });

  it('reads MachineGuid on Windows', async () => {
    const stdout = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    1234-abcd\r\n';
    expect(await osMachineId({ platform: 'win32', exec: async () => ({ stdout }) })).toBe('1234-abcd');
  });

  it('returns null when nothing can be read', async () => {
    expect(await osMachineId({ platform: 'linux', readFile: fail })).toBeNull();
  });
});

describe('fingerprints', () => {
  it('are hashes, stable, and differ per user', () => {
    const one = machineFingerprint('id', 'alice');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).toBe(machineFingerprint('id', 'alice'));
    expect(one).not.toBe(machineFingerprint('id', 'bob'));
    expect(one).not.toContain('alice');
  });

  it('falls back to the hostname', async () => {
    const fp = await currentFingerprint({ platform: 'linux', readFile: fail, hostname: () => 'box', username: () => 'alice' });
    expect(fp).toBe(machineFingerprint('box', 'alice'));
  });
});
