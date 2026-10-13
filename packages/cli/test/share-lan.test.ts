import { describe, expect, it } from 'vitest';
import { isPrivateIPv4, pickLanAddress } from '../src/share/lan.js';

const nic = (address: string, internal = false, family: 'IPv4' | 'IPv6' = 'IPv4') =>
  ({ address, internal, family, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as const;

describe('lan', () => {
  it('knows private ranges', () => {
    expect(['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.23'].every(isPrivateIPv4)).toBe(true);
    expect(['172.32.0.1', '8.8.8.8', '100.64.0.1', '169.254.1.1'].some(isPrivateIPv4)).toBe(false);
  });

  it('prefers Wi-Fi/Ethernet over VPN and virtual interfaces', () => {
    expect(
      pickLanAddress({
        lo0: [nic('127.0.0.1', true)],
        utun3: [nic('10.8.0.2')],
        bridge100: [nic('192.168.64.1')],
        en0: [nic('fe80::1', false, 'IPv6'), nic('192.168.1.23')],
      }),
    ).toBe('192.168.1.23');
  });

  it('takes any private address when no preferred interface has one, and null when none', () => {
    expect(pickLanAddress({ eth7: [nic('10.0.0.9')] })).toBe('10.0.0.9');
    expect(pickLanAddress({ lo0: [nic('127.0.0.1', true)], utun0: [nic('100.64.0.1')] })).toBeNull();
  });
});
