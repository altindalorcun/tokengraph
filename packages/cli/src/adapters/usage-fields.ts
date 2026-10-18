/** Field readers shared by the adapters that normalise Gemini-style token counters. */

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A required counter must be a finite, non-negative integer; anything else is malformed. */
export function readRequiredCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * A counter that defaults to 0 when the field is absent — that's not malformed, just an older
 * or leaner record. A *present* value must be a finite, non-negative integer; a present negative or
 * non-integer value is malformed (returns null) rather than being silently coerced to 0.
 */
export function readOptionalCount(value: unknown): number | null {
  return value === undefined ? 0 : readRequiredCount(value);
}

export function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}
