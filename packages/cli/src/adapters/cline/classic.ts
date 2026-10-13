import { dateKey } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { RequestBuckets, tierForModel } from '../request-buckets.js';
import { asObject, isValidTimestamp, normalizeClassic, readCount, shouldSkipProvider, type ClineDiagnostics } from './normalize.js';

export interface ClassicTask {
  taskId: string;
  /** Parsed ui_messages.json (or claude_messages.json) array. */
  messages: unknown[];
  /** Parsed task_metadata.json, or null when absent/unreadable. */
  metadata: unknown | null;
}

interface ModelUsageEntry {
  ts: number;
  providerId: string | null;
  modelId: string | null;
}

/** `task_metadata.json`'s `model_usage` timeline, sorted ascending by `ts`; malformed entries are dropped. */
function parseModelUsage(metadata: unknown): ModelUsageEntry[] {
  const list = asObject(metadata)?.['model_usage'];
  if (!Array.isArray(list)) return [];
  const entries: ModelUsageEntry[] = [];
  for (const item of list) {
    const entry = asObject(item);
    const ts = entry?.['ts'];
    if (!entry || typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    entries.push({
      ts,
      providerId: typeof entry['model_provider_id'] === 'string' ? entry['model_provider_id'] : null,
      modelId: typeof entry['model_id'] === 'string' ? entry['model_id'] : null,
    });
  }
  return entries.sort((a, b) => a.ts - b.ts);
}

/** The last `model_usage` entry at or before `ts` — the model that was active when the request started. */
function modelUsageAt(entries: ModelUsageEntry[], ts: number): ModelUsageEntry | null {
  let match: ModelUsageEntry | null = null;
  for (const entry of entries) {
    if (entry.ts > ts) break;
    match = entry;
  }
  return match;
}

/**
 * Reads one classic task's `ui_messages.json` and adds its billable requests to `buckets`.
 * `deleted_api_reqs` rows are ignored: they re-total requests a checkpoint restore already deleted
 * from the file, at the restore's own timestamp with no model — counting them risks re-adding
 * tokens a prior sync already captured from the original rows, onto the wrong day. Anything other
 * than `api_req_started` and `subagent_usage` (e.g. `api_req_finished`, plain chat) carries no
 * usage and is skipped.
 */
export function addClassicTask(
  task: ClassicTask,
  buckets: RequestBuckets,
  diagnostics: ClineDiagnostics,
  options: { since?: Date; timeZone?: string },
): void {
  const modelUsage = parseModelUsage(task.metadata);

  for (const raw of task.messages) {
    const entry = asObject(raw);
    if (!entry || entry['type'] !== 'say') continue;
    const say = entry['say'];
    if (say !== 'api_req_started' && say !== 'subagent_usage') continue;

    const ts = entry['ts'];
    if (!isValidTimestamp(ts)) {
      diagnostics.malformedEntries += 1;
      continue;
    }
    if (options.since && ts < options.since.getTime()) continue;

    const text = entry['text'];
    if (typeof text !== 'string') {
      diagnostics.malformedEntries += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      diagnostics.malformedEntries += 1; // malformed text: the entry's meaning cannot be determined
      continue;
    }
    const usage = asObject(parsed);
    if (!usage) {
      diagnostics.malformedEntries += 1;
      continue;
    }

    const tokensIn = readCount(usage['tokensIn']);
    const tokensOut = readCount(usage['tokensOut']);
    const cacheWrites = readCount(usage['cacheWrites']);
    const cacheReads = readCount(usage['cacheReads']);
    if (tokensIn === null || tokensOut === null || cacheWrites === null || cacheReads === null) {
      diagnostics.malformedEntries += 1; // a present negative counter, per the controller's ruling
      continue;
    }
    if (tokensIn === 0 && tokensOut === 0 && cacheWrites === 0 && cacheReads === 0) continue; // legitimate: no usage happened

    const modelInfo = asObject(entry['modelInfo']);
    let providerId: string | null;
    let modelId: string | null;
    if (modelInfo && typeof modelInfo['providerId'] === 'string' && typeof modelInfo['modelId'] === 'string') {
      providerId = modelInfo['providerId'];
      modelId = modelInfo['modelId'];
    } else {
      const fallback = modelUsageAt(modelUsage, ts);
      providerId = fallback?.providerId ?? null;
      modelId = fallback?.modelId ?? null;
    }
    // A subagent's own model can be overridden mid-group and the row's modelInfo (the parent
    // task's model) does not reflect that, so only the provider (the subagent reuses the parent's
    // provider configuration) is trusted here; the model is always unknown.
    if (say === 'subagent_usage') modelId = null;

    // This also means a bedrock subagent_usage row is always skipped as estimated below: the
    // parent's Claude model does not prove the (possibly overridden) subagent model was Claude,
    // and counting it on that basis would be a guess.
    if (shouldSkipProvider(providerId, modelId, diagnostics)) continue;

    const model = canonicalModelId(providerId, modelId);
    const counts = normalizeClassic(providerId, { tokensIn, tokensOut, cacheWrites, cacheReads }, diagnostics);
    const date = dateKey(new Date(ts), options.timeZone);
    const key = `classic:${task.taskId}:${ts}:${say}`;
    buckets.add(key, { date, model, pricingTier: tierForModel(model, counts), counts });
  }
}
