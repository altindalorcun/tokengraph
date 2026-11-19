import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CLAUDE_CODE_SOURCE, isKnownSource, type CollectResult, type LimitReading, type LimitWindowReading } from '@tokengraph/core';
import { renameWithRetry } from '../fs-retry.js';
import { limitsPath } from '../paths.js';

/**
 * `~/.tokengraph/limits.json`: the Claude Code limit readings, written by `tokengraph statusline` and by the
 * limit hits a scan finds. Local only: nothing here ever goes into a machine file or a gist. Codex readings are
 * not stored, because its session logs already hold them.
 */
export interface LimitsFile {
  schema: 1;
  claudeCode: LimitReading | null;
}

const EMPTY: LimitsFile = { schema: 1, claudeCode: null };

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function readWindow(raw: unknown): LimitWindowReading | null {
  if (!isObject(raw) || typeof raw['id'] !== 'string' || !finite(raw['usedPercent']) || !instant(raw['resetsAt'])) return null;
  return { id: raw['id'], minutes: finite(raw['minutes']) ? raw['minutes'] : null, usedPercent: raw['usedPercent'], resetsAt: raw['resetsAt'] };
}

/** A stored reading in a fixed key order, or null when it is not one; the same shape is written, so equal readings serialise equally. */
function readReading(raw: unknown): LimitReading | null {
  if (!isObject(raw) || typeof raw['source'] !== 'string' || !isKnownSource(raw['source']) || !instant(raw['readAt'])) return null;
  const origin = raw['origin'];
  if (origin !== 'statusline' && origin !== 'limit-hit' && origin !== 'session-log') return null;
  if (!Array.isArray(raw['windows'])) return null;
  const windows = raw['windows'].map(readWindow);
  if (windows.some((w) => w === null)) return null;
  return {
    source: raw['source'],
    limitId: typeof raw['limitId'] === 'string' ? raw['limitId'] : null,
    plan: typeof raw['plan'] === 'string' ? raw['plan'] : null,
    origin,
    readAt: raw['readAt'],
    credits: null,
    windows: windows as LimitWindowReading[],
  };
}

export async function readLimitsFile(path: string = limitsPath()): Promise<LimitsFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isObject(parsed) || parsed['schema'] !== 1) return { ...EMPTY };
    return { schema: 1, claudeCode: readReading(parsed['claudeCode']) };
  } catch {
    return { ...EMPTY };
  }
}

/** Per window, the one from the newer reading wins; a window only one side has is kept. */
export function mergeClaudeReading(stored: LimitReading | null, next: LimitReading): LimitReading {
  if (!stored) return next;
  const nextIsNewer = Date.parse(next.readAt) >= Date.parse(stored.readAt);
  const [older, newer] = nextIsNewer ? [stored, next] : [next, stored];
  const windows = new Map<string, LimitWindowReading>();
  for (const window of older.windows) windows.set(window.id, window);
  for (const window of newer.windows) windows.set(window.id, window);
  return { ...newer, windows: [...windows.values()] };
}

/** Merges `next` into the stored Claude Code reading and writes it when anything changed. Never throws; true when written. */
export async function storeClaudeReading(next: LimitReading, path: string = limitsPath()): Promise<boolean> {
  try {
    const stored = (await readLimitsFile(path)).claudeCode;
    const merged = readReading(mergeClaudeReading(stored, next));
    if (!merged || JSON.stringify(merged) === JSON.stringify(stored)) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Several Claude Code sessions can refresh their status lines at once: each writes its own temp file.
    const temporary = `${path}.${process.pid}.${randomInt(1_000_000_000)}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schema: 1, claudeCode: merged } satisfies LimitsFile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameWithRetry(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/** Stores the limit hits a scan found in Claude Code transcripts. Never throws. */
export async function recordLimitHits(results: readonly CollectResult[], path: string = limitsPath()): Promise<void> {
  for (const result of results) {
    if (result.source !== CLAUDE_CODE_SOURCE) continue;
    for (const reading of result.limits ?? []) await storeClaudeReading(reading, path);
  }
}
