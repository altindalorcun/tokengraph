import type { SplitTokenCounts } from '@tokengraph/core';

/**
 * A JSON value as a plain record, or null when it isn't one. An array is deliberately rejected
 * even though `typeof [] === 'object'`: a classic row's `text` can decode to a bare JSON array
 * (e.g. `"[1,2,3]"`), and an SDK message's `metrics` can be written as `[]` — treating either as a
 * record would silently read every field as `undefined` and default every counter to 0 instead of
 * flagging the record as malformed.
 */
export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * True for a finite number that also constructs a valid `Date` — a huge-but-finite value like
 * `1e20` is finite yet produces an out-of-range instant, and `dateKey` throws a `RangeError` on
 * that rather than returning a string. Every `ts` read from an untrusted file must pass this
 * before it is used to bucket a request by day.
 */
export function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

/**
 * A present number must be a non-negative integer to be used; a present *negative or non-integer*
 * number makes the whole entry's meaning undeterminable (the controller ruled clamping or
 * truncating it away would hide a malformed record), so this returns null to signal "skip the
 * entry". Anything else — absent, the wrong type, or non-finite — defaults to 0. Shared by the
 * classic and SDK readers, whose usage counters follow the same rule.
 */
export function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < 0 || !Number.isInteger(value) ? null : value;
}

/**
 * Providers whose classic `tokensIn` already excludes cache reads and writes (Anthropic's own
 * API shape, or a gateway that has been observed subtracting the cache subtotals itself). Every
 * other provider — including any providerId this adapter has never seen — is treated as
 * cache-inclusive: that never double-counts, whereas guessing "exclusive" for an unlisted
 * provider could undercount by subtracting a cache subtotal that was never added in.
 */
export const CACHE_EXCLUSIVE_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'vertex',
  'minimax',
  'aihubmix',
  'bedrock',
  'openrouter',
  'cline',
  'vercel-ai-gateway',
  'gemini',
  'openai-native',
  'groq',
  'moonshot',
  'deepseek',
]);

export interface ClineDiagnostics {
  /** Fresh input (tokensIn/inputTokens minus cache subtotals) would have gone negative; clamped to 0. */
  clamped: number;
  /** `claude-code` provider: that usage is Claude Code itself, already counted by our Claude Code adapter. */
  skippedClaudeCode: number;
  /** `bedrock` with a non-Claude model: Cline estimates usage from text length there, never a real count. */
  skippedEstimated: number;
  /** SDK messages imported into a Cline session from another tool's own transcript. */
  skippedImported: number;
  /** SDK messages copied from a classic task's final totals when the task was migrated to the SDK format. */
  skippedLegacyCopies: number;
  /** A task or session file could not be read or parsed at all. */
  unreadableFiles: number;
  /** A usage-bearing entry (api_req_started/subagent_usage, or the SDK equivalent) whose own shape could not be read: bad ts, bad text/JSON, or a negative counter. */
  malformedEntries: number;
}

export function emptyClineDiagnostics(): ClineDiagnostics {
  return {
    clamped: 0,
    skippedClaudeCode: 0,
    skippedEstimated: 0,
    skippedImported: 0,
    skippedLegacyCopies: 0,
    unreadableFiles: 0,
    malformedEntries: 0,
  };
}

/**
 * Classic-format (`ui_messages.json`) usage → our counters. Which half of `tokensIn` is cache
 * depends on the provider: an exclusive provider's `tokensIn` is already fresh input, while every
 * other provider's `tokensIn` includes the cache subtotals and must have them subtracted back out
 * (see {@link CACHE_EXCLUSIVE_PROVIDERS}). `providerId` null means an unknown/unrecorded provider
 * (pre-3.12 tasks), which falls back to the cache-inclusive rule.
 */
export function normalizeClassic(
  providerId: string | null,
  usage: { tokensIn: number; tokensOut: number; cacheWrites: number; cacheReads: number },
  diagnostics: ClineDiagnostics,
): SplitTokenCounts {
  const exclusive = providerId !== null && CACHE_EXCLUSIVE_PROVIDERS.has(providerId);
  let inputTokens = usage.tokensIn;
  if (!exclusive) {
    const fresh = usage.tokensIn - usage.cacheReads - usage.cacheWrites;
    if (fresh < 0) diagnostics.clamped += 1;
    inputTokens = Math.max(0, fresh);
  }
  return {
    inputTokens,
    outputTokens: usage.tokensOut,
    cacheCreationTokens: usage.cacheWrites,
    cacheReadTokens: usage.cacheReads,
    // No classic provider ever writes a 5m/1h cache-write split.
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
  };
}

/**
 * SDK-format (`<sessionId>.messages.json`) metrics → our counters. `inputTokens` there always
 * includes both cache subtotals (the AI SDK's `inputTokens.total`), regardless of provider, so the
 * subtraction is unconditional.
 */
export function normalizeSdk(
  metrics: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  diagnostics: ClineDiagnostics,
): SplitTokenCounts {
  const fresh = metrics.inputTokens - metrics.cacheReadTokens - metrics.cacheWriteTokens;
  if (fresh < 0) diagnostics.clamped += 1;
  return {
    inputTokens: Math.max(0, fresh),
    outputTokens: metrics.outputTokens,
    cacheCreationTokens: metrics.cacheWriteTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
  };
}

/**
 * True when a request must not be counted by this adapter. `claude-code` runs Claude Code itself
 * as a subprocess, whose own transcript the Claude Code adapter already counts. `bedrock` with a
 * model id that does not mention Claude is Cline's own text-length estimate, not a real count from
 * the provider, and "nothing is estimated" rules it out; a Claude model on Bedrock reports real
 * usage (AWS Converse), so it is still counted.
 */
export function shouldSkipProvider(providerId: string | null, modelId: string | null, diagnostics: ClineDiagnostics): boolean {
  if (providerId === 'claude-code') {
    diagnostics.skippedClaudeCode += 1;
    return true;
  }
  if (providerId === 'bedrock' && !(modelId ?? '').toLowerCase().includes('claude')) {
    diagnostics.skippedEstimated += 1;
    return true;
  }
  return false;
}
