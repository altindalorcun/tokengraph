import type { SplitTokenCounts } from '@tokengraph/core';

/**
 * The five counters OpenCode stores per request (message or step-finish part), in the note's
 * notation: I=input, O=output, R=reasoning, CR=cache.read, CW=cache.write, T=total.
 */
export interface StoredTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number | null;
}

export interface VersionContext {
  /** session.version as stored (the OpenCode version that created the session), or null if absent. */
  sessionVersion: string | null;
  /** session.time_created (ms), or null if unknown. */
  sessionCreatedMs: number | null;
  /** The assistant message's time.created (ms). */
  messageCreatedMs: number;
}

export type SkipReason = 'invalid' | 'no-total' | 'ambiguous' | 'aisdk6-window' | 'claude-code' | 'ignored';
export type Resolution = { counts: SplitTokenCounts } | { skip: SkipReason };

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Parses a raw `tokens` object (`{input, output, reasoning, total?, cache: {read, write}}`).
 * `input`/`output` are required; `reasoning`, `cache.read`, `cache.write` default to 0 when
 * absent and `total` defaults to null. Any field that *is* present but is not a finite,
 * non-negative integer makes the whole object unusable (returns null) — a record we cannot
 * trust part of is not trusted at all, per the global "never counted as 0" rule.
 */
export function parseStoredTokens(raw: unknown): StoredTokens | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const input = obj['input'];
  const output = obj['output'];
  if (!isNonNegativeInteger(input) || !isNonNegativeInteger(output)) return null;

  const reasoningRaw = obj['reasoning'];
  if (reasoningRaw !== undefined && !isNonNegativeInteger(reasoningRaw)) return null;
  const reasoning = reasoningRaw === undefined ? 0 : reasoningRaw;

  const cacheRaw = obj['cache'];
  const cache = typeof cacheRaw === 'object' && cacheRaw !== null && !Array.isArray(cacheRaw) ? (cacheRaw as Record<string, unknown>) : undefined;

  const cacheReadRaw = cache?.['read'];
  if (cacheReadRaw !== undefined && !isNonNegativeInteger(cacheReadRaw)) return null;
  const cacheRead = cacheReadRaw === undefined ? 0 : cacheReadRaw;

  const cacheWriteRaw = cache?.['write'];
  if (cacheWriteRaw !== undefined && !isNonNegativeInteger(cacheWriteRaw)) return null;
  const cacheWrite = cacheWriteRaw === undefined ? 0 : cacheWriteRaw;

  const totalRaw = obj['total'];
  if (totalRaw !== undefined && totalRaw !== null && !isNonNegativeInteger(totalRaw)) return null;
  const total = totalRaw === undefined || totalRaw === null ? null : totalRaw;

  return { input, output, reasoning, cacheRead, cacheWrite, total };
}

function counts(input: number, output: number, cacheWrite: number, cacheRead: number): SplitTokenCounts {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    // OpenCode never records a 5m/1h cache-write split.
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
  };
}

/** Semver-ish compare of plain `x.y.z` versions; null when either side is not plain x.y.z. */
export function compareVersions(a: string, b: string): number | null {
  const pattern = /^\d+\.\d+\.\d+$/;
  if (!pattern.test(a) || !pattern.test(b)) return null;
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (partsA[i] !== partsB[i]) return partsA[i]! < partsB[i]! ? -1 : 1;
  }
  return 0;
}

/** True when `version` is a parseable x.y.z at least `floor`. Null/unparseable is never "at least". */
function isAtLeast(version: string | null, floor: string): boolean {
  if (version === null) return false;
  const cmp = compareVersions(version, floor);
  return cmp !== null && cmp >= 0;
}

/**
 * The per-product version facts the v1 rule needs. OpenCode and its forks share one `getUsage()`
 * history but number their releases differently, so the thresholds are parameters.
 */
export interface SemanticsRules {
  /** First version whose five fields are disjoint (period D): 1.3.16 for OpenCode, 7.2.6 for Kilo. */
  periodDFloor: string;
  /** Start (ms) of the 1.3.4-1.3.5 AI SDK 6 window; null when the product never had that window. */
  aisdk6WindowStartMs: number | null;
  /** First version after the AI SDK 6 window; only read when `aisdk6WindowStartMs` is set. */
  aisdk6WindowClearedFrom: string;
}

export const OPENCODE_RULES: SemanticsRules = {
  periodDFloor: '1.3.16',
  aisdk6WindowStartMs: Date.parse('2026-03-27T20:24:30Z'),
  aisdk6WindowClearedFrom: '1.3.6',
};

/**
 * OpenCode v1 (SQLite `message`/`part`, and the pre-1.2.0 JSON storage) request semantics.
 *
 * `getUsage()` (`packages/opencode/src/session/session.ts`) changed what `tokens.input` and
 * `tokens.output` mean four times across OpenCode's history (see `docs/agents/opencode-usage.md`,
 * "Field semantics: the history of `getUsage()`" and "Decision rule for old records" — that
 * note is the source of truth for the arithmetic below; this function encodes its "Decision rule
 * for old records" exactly). The short version: from 1.3.16 onward the five fields are disjoint and can be
 * read directly (the "period-D shortcut"); before that, `tokens.total` (when present, from
 * 1.1.57) lets the four possible readings of input/output be tried against it, and the
 * reading is kept only when exactly one is arithmetically consistent. The one dangerous
 * window is 1.3.4–1.3.5, where an Anthropic/Bedrock/Vertex-Anthropic-class record's `total`
 * double-counts cache and must be rejected rather than misread.
 *
 * The rule assumes a user never downgrades OpenCode and resumes an old session with an older
 * build — `session.version` is trusted as a lower bound on every message's writing version
 * once it postdates the session's own creation.
 */
export function resolveV1Tokens(tokens: StoredTokens, context: VersionContext, rules: SemanticsRules = OPENCODE_RULES): Resolution {
  const { input: I, output: O, reasoning: R, cacheRead: CR, cacheWrite: CW, total: T } = tokens;

  // 1. Period-D shortcut: a session created by >= `rules.periodDFloor`, for a message that isn't an
  // inherited fork clone (a fork clone keeps its original, earlier time.created).
  if (
    isAtLeast(context.sessionVersion, rules.periodDFloor) &&
    context.sessionCreatedMs !== null &&
    context.messageCreatedMs >= context.sessionCreatedMs
  ) {
    return { counts: counts(I, O + R, CW, CR) };
  }

  // 2. No total: only safe when cache and reasoning are both absent (nothing to disambiguate).
  if (T === null) {
    if (CR === 0 && CW === 0 && R === 0) return { counts: counts(I, O, 0, 0) };
    return { skip: 'no-total' };
  }

  // 3. Candidates: first letter is whether input includes cache, second whether output
  // includes reasoning. A candidate is only considered when its own subtraction doesn't go
  // negative, and then only kept when its implied total equals T.
  type Candidate = { family: 'n' | 'y'; input: number; output: number };
  const candidates: Candidate[] = [];

  if (I + CR + CW + O + R === T) candidates.push({ family: 'n', input: I, output: O + R }); // nn
  if (O - R >= 0 && I + CR + CW + O === T) candidates.push({ family: 'n', input: I, output: O }); // ny
  const fresh = I - CR - CW;
  if (fresh >= 0 && I + O + R === T) candidates.push({ family: 'y', input: fresh, output: O + R }); // yn
  if (fresh >= 0 && O - R >= 0 && I + O === T) candidates.push({ family: 'y', input: fresh, output: O }); // yy

  if (candidates.length === 0) return { skip: 'ambiguous' };
  const [first, ...rest] = candidates;
  if (rest.some((candidate) => candidate.input !== first!.input || candidate.output !== first!.output)) {
    return { skip: 'ambiguous' };
  }
  if (CR + CW > 0 && candidates.every((candidate) => candidate.family === 'y')) {
    return { skip: 'ambiguous' };
  }

  // 4. 1.3.4-1.3.5 AI SDK 6 window: an Anthropic-class record there reports `total` inflated
  // by double-counted cache, which arithmetic alone cannot tell apart from a genuine
  // cache-inclusive-input reading. R > 0 or CR+CW === 0 records are unaffected and safe.
  if (rules.aisdk6WindowStartMs !== null && CR + CW > 0 && R === 0) {
    const versionClearsWindow =
      isAtLeast(context.sessionVersion, rules.aisdk6WindowClearedFrom) &&
      context.sessionCreatedMs !== null &&
      context.messageCreatedMs >= context.sessionCreatedMs;
    const couldBeWindowed = context.messageCreatedMs >= rules.aisdk6WindowStartMs && !versionClearsWindow;
    if (couldBeWindowed) return { skip: 'aisdk6-window' };
  }

  // 5. Agreed reading.
  return { counts: counts(first!.input, first!.output, CW, CR) };
}

/** v2 `session_message` rows: always period-D semantics (no `total`, no ambiguity to resolve). */
export function resolveV2Tokens(tokens: StoredTokens): SplitTokenCounts {
  return counts(tokens.input, tokens.output + tokens.reasoning, tokens.cacheWrite, tokens.cacheRead);
}
