import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome } from '../../paths.js';

/**
 * One Cursor agent turn, as recorded by the `stop` hook. Cursor keeps no usable token counters
 * of its own on disk, so this file is the only record of Cursor usage and is never pruned.
 *
 * Only these fields are ever stored: the hook payload also carries the conversation id,
 * the user's e-mail, a transcript path and the assistant's text, none of which leave the payload.
 * The first workspace root is the one exception: it is read for per-project totals, stays on this
 * machine and never reaches a gist. Message text is still never read.
 * Token counts stay null when the payload omits them — Cursor does not document these fields,
 * and an absent count is unknown, not zero.
 */
export interface CursorEvent {
  v: 1;
  /** Cursor's hook payload has no timestamp, so the hook stamps the time it ran. */
  receivedAt: string;
  generationId: string;
  model: string | null;
  modelId: string | null;
  /** Composer's Fast variant is reported as a `fast` model parameter, not as a model name. */
  fast: boolean;
  status: string | null;
  cursorVersion: string | null;
  /** The payload's first `workspace_roots` entry. Absent on older lines and when the payload had none. */
  folder?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** A path longer than this is unexpected input, so it is left out rather than cut. */
const MAX_FOLDER_LENGTH = 1024;

function firstRoot(roots: unknown): string | undefined {
  const root: unknown = Array.isArray(roots) ? roots[0] : undefined;
  return typeof root === 'string' && root.length > 0 && root.length <= MAX_FOLDER_LENGTH ? root : undefined;
}

export function cursorEventsPath(): string {
  return join(configHome(), 'cursor-events.jsonl');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Cursor's own fields are short; a much longer string is unexpected input, not a real value. */
const MAX_STRING_LENGTH = 200;

/** Like {@link nonEmptyString}, but truncates instead of rejecting — used for free-form fields. */
function truncatedString(value: unknown): string | null {
  const stringValue = nonEmptyString(value);
  return stringValue ? stringValue.slice(0, MAX_STRING_LENGTH) : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function isFastParam(param: unknown): boolean {
  const fields = asObject(param);
  if (!fields) return false;
  const id = fields['id'] ?? fields['name'];
  const value = fields['value'];
  return id === 'fast' && (value === true || value === 'true');
}

export function eventFromHookPayload(payload: unknown, receivedAt: Date): CursorEvent | null {
  const fields = asObject(payload);
  if (!fields) return null;
  const event = fields['hook_event_name'];
  if (event !== undefined && event !== 'stop') return null;
  const generationId = nonEmptyString(fields['generation_id']);
  if (!generationId || generationId.length > MAX_STRING_LENGTH) return null;
  const params = fields['model_params'];
  const folder = firstRoot(fields['workspace_roots']);
  return {
    v: 1,
    receivedAt: receivedAt.toISOString(),
    generationId,
    model: truncatedString(fields['model']),
    modelId: truncatedString(fields['model_id']),
    fast: Array.isArray(params) && params.some(isFastParam),
    status: truncatedString(fields['status']),
    cursorVersion: truncatedString(fields['cursor_version']),
    ...(folder ? { folder } : {}),
    inputTokens: count(fields['input_tokens']),
    outputTokens: count(fields['output_tokens']),
    cacheReadTokens: count(fields['cache_read_tokens']),
    cacheWriteTokens: count(fields['cache_write_tokens']),
  };
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return count(value) ?? undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return nonEmptyString(value) ?? undefined;
}

/** Drops anything malformed rather than throwing — one damaged line must not block a sync. */
export function parseCursorEvent(line: string): CursorEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const fields = asObject(raw);
  if (!fields || fields['v'] !== 1) return null;
  const generationId = nonEmptyString(fields['generationId']);
  const receivedAt = nonEmptyString(fields['receivedAt']);
  if (!generationId || !receivedAt || Number.isNaN(new Date(receivedAt).getTime())) return null;
  if (typeof fields['fast'] !== 'boolean') return null;

  const model = nullableString(fields['model']);
  const modelId = nullableString(fields['modelId']);
  const status = nullableString(fields['status']);
  const cursorVersion = nullableString(fields['cursorVersion']);
  const folder = firstRoot([fields['folder']]);
  const inputTokens = nullableCount(fields['inputTokens']);
  const outputTokens = nullableCount(fields['outputTokens']);
  const cacheReadTokens = nullableCount(fields['cacheReadTokens']);
  const cacheWriteTokens = nullableCount(fields['cacheWriteTokens']);
  if (
    model === undefined ||
    modelId === undefined ||
    status === undefined ||
    cursorVersion === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return null;
  }
  return {
    v: 1,
    receivedAt,
    generationId,
    model,
    modelId,
    fast: fields['fast'],
    status,
    cursorVersion,
    ...(folder ? { folder } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export async function appendCursorEvent(event: CursorEvent): Promise<void> {
  await mkdir(configHome(), { recursive: true, mode: 0o700 });
  await appendFile(cursorEventsPath(), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}
