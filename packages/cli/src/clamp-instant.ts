/**
 * An ISO instant that is never later than `limitMs` (default: now). A "covered through" instant in the
 * future (a machine whose clock ran ahead once) would hide everything fetched or recorded after it, so every
 * place that writes or reads one clamps it. Returns the normalised ISO string, or null for an unreadable value.
 */
export function clampInstant(value: string, limitMs: number = Date.now()): string | null {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return new Date(Math.min(at, limitMs)).toISOString();
}
