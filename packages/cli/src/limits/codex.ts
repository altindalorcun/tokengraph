import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { CODEX_CLI_SOURCE, type LimitCredits, type LimitReading, type LimitWindowReading } from '@tokengraph/core';
import { planScan, type RootsOption } from '../agent-roots.js';
import { resolveAdapterRoots } from '../agent-roots-store.js';
import { jsonlFiles, readLines } from '../adapters/jsonl-files.js';
import { CODEX_ROOTS } from '../adapters/codex/roots.js';

/** How many of the most recently written rollout files are read: the newest reading is in one of them. */
const DEFAULT_MAX_FILES = 8;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function window(id: string, raw: unknown, readAt: number): LimitWindowReading | null {
  if (!isObject(raw) || !finite(raw['used_percent'])) return null;
  let resetsAt: number;
  if (finite(raw['resets_at'])) resetsAt = raw['resets_at'] * 1000;
  // Older Codex versions write the time left instead of the instant.
  else if (finite(raw['resets_in_seconds'])) resetsAt = readAt + raw['resets_in_seconds'] * 1000;
  else return null;
  const minutes = finite(raw['window_minutes']) && raw['window_minutes'] > 0 ? raw['window_minutes'] : null;
  return { id, minutes, usedPercent: raw['used_percent'], resetsAt: new Date(resetsAt).toISOString() };
}

function credits(raw: unknown): LimitCredits | null {
  if (!isObject(raw)) return null;
  const balance = raw['balance'];
  return {
    hasCredits: raw['has_credits'] === true,
    unlimited: raw['unlimited'] === true,
    balance: typeof balance === 'string' ? balance : finite(balance) ? String(balance) : null,
  };
}

/** The limit reading of one rollout record (`event_msg` / `token_count` with `rate_limits`), or null. */
export function parseCodexRateLimits(record: unknown): LimitReading | null {
  if (!isObject(record) || record['type'] !== 'event_msg') return null;
  const payload = record['payload'];
  if (!isObject(payload) || payload['type'] !== 'token_count') return null;
  const limits = payload['rate_limits'];
  if (!isObject(limits)) return null;
  const timestamp = record['timestamp'];
  const readAt = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(readAt)) return null;
  const windows = (['primary', 'secondary'] as const)
    .map((id) => window(id, limits[id], readAt))
    .filter((w): w is LimitWindowReading => w !== null);
  if (windows.length === 0) return null;
  return {
    source: CODEX_CLI_SOURCE,
    limitId: text(limits['limit_id']),
    plan: text(limits['plan_type']),
    origin: 'session-log',
    readAt: timestamp as string,
    credits: credits(limits['credits']),
    windows,
  };
}

/**
 * The newest Codex limit reading per `limit_id`, from the most recently written rollout files of every Codex
 * home. Files are picked by modification time, not by day folder: a resumed session appends to its old file.
 */
export async function readCodexLimits(options: RootsOption & { maxFiles?: number } = {}): Promise<LimitReading[]> {
  const { ctx, remembered } = await resolveAdapterRoots(CODEX_ROOTS, options.roots);
  const targets = (await planScan(CODEX_ROOTS, ctx, remembered)).filter((target) => target.exists);
  const files: { path: string; mtime: number }[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    for await (const path of jsonlFiles(target.path)) {
      if (!basename(path).startsWith('rollout-') || seen.has(path)) continue;
      seen.add(path);
      const info = await stat(path).catch(() => null);
      if (info) files.push({ path, mtime: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const newest = new Map<string, LimitReading>();
  for (const { path } of files.slice(0, options.maxFiles ?? DEFAULT_MAX_FILES)) {
    await readLines(path, (line) => {
      // Cheap filter first: most lines are not token counts.
      if (!line.includes('"rate_limits"')) return;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      const reading = parseCodexRateLimits(record);
      if (!reading) return;
      const key = reading.limitId ?? '';
      const held = newest.get(key);
      if (!held || Date.parse(reading.readAt) >= Date.parse(held.readAt)) newest.set(key, reading);
    }).catch(() => undefined);
  }
  return [...newest.values()];
}
