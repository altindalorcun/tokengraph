import type { Scope } from './app-state.js';

/** Past this age the cached machines are probably behind, and the header says to sync. */
export const STALE_MACHINES_MS = 24 * 60 * 60 * 1000;

function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The header's machines line: how many machines the numbers cover and how old the other machines' figures are, or
 * which scope to switch to. Null with no other machine cached, so a one-machine user sees nothing new.
 */
export function machinesLine(
  machines: { count: number; publishedAt: string | null } | null,
  scope: Scope,
  now: number,
): { text: string; stale: boolean } | null {
  if (!machines || machines.count === 0) return null;
  if (scope === 'this') return { text: 'this machine · a for all', stale: false };
  const total = `${machines.count + 1} machines`;
  const at = machines.publishedAt === null ? Number.NaN : Date.parse(machines.publishedAt);
  if (Number.isNaN(at)) return { text: total, stale: false };
  const stale = now - at > STALE_MACHINES_MS;
  return { text: `${total} · others as of ${age(now - at)}${stale ? ' · sync to refresh' : ''}`, stale };
}
