import { dateKey } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { RequestBuckets, tierForModel } from '../request-buckets.js';
import { asObject, isValidTimestamp, normalizeSdk, readCount, shouldSkipProvider, type ClineDiagnostics } from './normalize.js';

/** One SDK session's `<id>.messages.json` (main agent or subagent), plus its session manifest. */
export interface SdkMessagesFile {
  /** Parsed <id>.messages.json. */
  document: unknown;
  /** Parsed <sessionId>.json manifest of the session directory, or null. */
  manifest: unknown | null;
}

const LEGACY_WARNING_PREFIX = 'Warning: this is a legacy conversation';

/**
 * True when any text part of a message's `content` starts with the legacy-migration warning
 * prefix. Only the prefix is ever inspected or compared; the text itself is never kept.
 */
function hasLegacyWarning(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const obj = asObject(part);
    const text = obj?.['text'];
    return typeof text === 'string' && text.startsWith(LEGACY_WARNING_PREFIX);
  });
}

/** Index of the first user message carrying the legacy-migration warning, or -1 if none. */
function legacyWarningIndex(messages: unknown[]): number {
  return messages.findIndex((raw) => {
    const entry = asObject(raw);
    return entry?.['role'] === 'user' && hasLegacyWarning(entry['content']);
  });
}

/** `metadata.importedFrom.importedAt` as an epoch-ms cutoff; null when present but unparseable. */
function importedAtCutoff(importedFrom: Record<string, unknown>): number | null {
  const importedAt = importedFrom['importedAt'];
  if (typeof importedAt === 'number' && Number.isFinite(importedAt)) return importedAt;
  if (typeof importedAt === 'string') {
    const parsed = Date.parse(importedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Reads one SDK session file (the main agent's or a subagent's `.messages.json`) and adds its
 * billable assistant turns to `buckets`. See `docs/cline-usage.md` "B. SDK oturumu" for the shape
 * and the imported/legacy-migration edge cases implemented here.
 */
export function addSdkMessages(
  file: SdkMessagesFile,
  buckets: RequestBuckets,
  diagnostics: ClineDiagnostics,
  options: { since?: Date; timeZone?: string },
): void {
  const doc = asObject(file.document);
  const messages = doc && Array.isArray(doc['messages']) ? doc['messages'] : [];
  if (messages.length === 0) return;

  const manifest = asObject(file.manifest);
  const metadata = manifest ? asObject(manifest['metadata']) : null;

  const importedFrom = metadata ? asObject(metadata['importedFrom']) : null;
  // undefined: no importedFrom object at all — never skip on this basis.
  // null: importedFrom present but importedAt could not be parsed — skip every message below.
  // number: the cutoff epoch ms — skip ts <= cutoff.
  const importedCutoff: number | null | undefined = importedFrom ? importedAtCutoff(importedFrom) : undefined;

  const isLegacyMigrated = Boolean(metadata?.['legacyTask']) || Boolean(metadata?.['migratedFromLegacyTask']);
  // Assistant messages at an index below this were copied from a classic task's own totals and are
  // skipped. Infinity when the file claims a migration but never actually shows the warning text,
  // which means the whole file cannot be trusted, so every assistant message in it is skipped.
  let legacySkipBelowIndex = -1;
  if (isLegacyMigrated) {
    const warningIndex = legacyWarningIndex(messages);
    legacySkipBelowIndex = warningIndex === -1 ? Number.POSITIVE_INFINITY : warningIndex;
  }

  for (let index = 0; index < messages.length; index++) {
    const entry = asObject(messages[index]);
    if (!entry || entry['role'] !== 'assistant') continue;

    if (!('metrics' in entry)) continue; // not a usage-bearing message
    const metrics = asObject(entry['metrics']);
    if (!metrics) {
      diagnostics.malformedEntries += 1;
      continue;
    }

    // Checked before the id/ts shape: a legacy-migration synthetic total is recognisable by its
    // provider alone, and must be reported as a legacy copy even when its ts or id is also bad —
    // never as a generic malformed entry, which would misdescribe why it was skipped.
    const modelInfo = asObject(entry['modelInfo']);
    const provider = typeof modelInfo?.['provider'] === 'string' ? (modelInfo['provider'] as string) : null;
    const modelId = typeof modelInfo?.['id'] === 'string' ? (modelInfo['id'] as string) : null;
    if (provider === 'unknown') {
      diagnostics.skippedLegacyCopies += 1;
      continue;
    }

    const id = entry['id'];
    if (typeof id !== 'string' || id.length === 0) {
      diagnostics.malformedEntries += 1; // a usage-bearing message with no usable id to dedup on
      continue;
    }

    const ts = entry['ts'];
    if (!isValidTimestamp(ts)) {
      diagnostics.malformedEntries += 1; // has metrics but no usable timestamp
      continue;
    }
    if (options.since && ts < options.since.getTime()) continue;

    const inputTokens = readCount(metrics['inputTokens']);
    const outputTokens = readCount(metrics['outputTokens']);
    const cacheReadTokens = readCount(metrics['cacheReadTokens']);
    const cacheWriteTokens = readCount(metrics['cacheWriteTokens']);
    if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null) {
      diagnostics.malformedEntries += 1; // a present negative or non-integer counter, per the controller's ruling
      continue;
    }

    if (shouldSkipProvider(provider, modelId, diagnostics)) continue;

    if (importedCutoff === null || (typeof importedCutoff === 'number' && ts <= importedCutoff)) {
      diagnostics.skippedImported += 1;
      continue;
    }
    if (index < legacySkipBelowIndex) {
      diagnostics.skippedLegacyCopies += 1;
      continue;
    }

    const model = canonicalModelId(provider, modelId);
    const counts = normalizeSdk({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, diagnostics);
    const date = dateKey(new Date(ts), options.timeZone);
    // Session-independent: a forked session copies earlier messages with the same id, and this key
    // lets them merge into one request instead of being double-counted.
    buckets.add(`sdk:${id}`, { date, model, pricingTier: tierForModel(model, counts), counts });
  }
}
