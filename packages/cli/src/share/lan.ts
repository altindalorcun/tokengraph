import type { NetworkInterfaceInfo } from 'node:os';

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Wi-Fi and Ethernet first; VPN tunnels and VM bridges are where a phone cannot reach.
const PREFERRED = /^(en|eth|wlan|wl|wlp|enp|eno|ens|Wi-?Fi|Ethernet)/i;
const VIRTUAL = /^(utun|tun|tap|bridge|vboxnet|vmnet|docker|br-|veth|virbr|lo\d*$|awdl|llw|zt|tailscale)/i;

export function pickLanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) candidates.push({ name, address: entry.address });
    }
  }
  const preferred = candidates.find((c) => PREFERRED.test(c.name) && !VIRTUAL.test(c.name));
  const other = candidates.find((c) => !VIRTUAL.test(c.name));
  return (preferred ?? other)?.address ?? null;
}
