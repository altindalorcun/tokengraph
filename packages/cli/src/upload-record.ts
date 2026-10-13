import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDateKey, isKnownSource, type DayUsage, type KnownSource, type UsagePayload } from '@tokengraph/core';
import { renameWithRetry } from './fs-retry.js';

export const UPLOAD_RECORD_VERSION = 1;

/**
 * An automatic sync re-sends a day it already uploaded once this much time has passed, even if it
 * did not change. The server only ever keeps the larger value, so a re-send is harmless; it repairs
 * a server that lost data (a restore from backup) and keeps the machine's "last synced" time inside
 * the week after which the dashboard calls it stale.
 */
export const REFRESH_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

export interface UploadedDay {
  /** Fingerprint of the day exactly as it was sent. */
  fingerprint: string;
  /** Epoch ms of the upload. */
  at: number;
}

export interface UploadRecord {
  version: typeof UPLOAD_RECORD_VERSION;
  /** The server and device the days were sent to; anything else starts from an empty record. */
  target: string;
  sources: Partial<Record<KnownSource, Record<string, UploadedDay>>>;
}

export function uploadTarget(apiUrl: string, deviceId: string): string {
  return `${apiUrl} ${deviceId}`;
}

export function emptyUploadRecord(target: string): UploadRecord {
  return { version: UPLOAD_RECORD_VERSION, target, sources: {} };
}

/** The models are already in a stable order (`buildUsagePayload` sorts them), so equal days hash equal. */
export function dayFingerprint(day: DayUsage): string {
  return createHash('sha256').update(JSON.stringify(day.models)).digest('hex').slice(0, 32);
}

/**
 * The part of a payload that still has to go up: days that are new, changed since they were sent,
 * or were last sent more than `REFRESH_AFTER_MS` ago. Null when nothing does.
 */
export function pendingPayload(payload: UsagePayload, record: UploadRecord, now: number): UsagePayload | null {
  const sent = record.sources[payload.source] ?? {};
  const days = payload.days.filter((day) => {
    const previous = sent[day.date];
    return !previous || previous.fingerprint !== dayFingerprint(day) || now - previous.at >= REFRESH_AFTER_MS;
  });
  return days.length > 0 ? { ...payload, days } : null;
}

/**
 * An entry this old belongs to a day that has left every automatic sync's window (days inside it
 * are re-sent every `REFRESH_AFTER_MS`), so it is dropped. Dropping one too early only costs a re-send.
 */
const FORGET_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

/** Marks every day of an accepted payload as sent at `now`, and forgets entries nothing will ask about. */
export function recordUpload(record: UploadRecord, payload: UsagePayload, now: number): UploadRecord {
  const days: Record<string, UploadedDay> = {};
  for (const [date, day] of Object.entries(record.sources[payload.source] ?? {})) {
    if (now - day.at < FORGET_AFTER_MS) days[date] = day;
  }
  for (const day of payload.days) days[day.date] = { fingerprint: dayFingerprint(day), at: now };
  return { ...record, sources: { ...record.sources, [payload.source]: days } };
}

function readDay(value: unknown): UploadedDay | null {
  if (typeof value !== 'object' || value === null) return null;
  const { fingerprint, at } = value as Record<string, unknown>;
  if (typeof fingerprint !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { fingerprint, at };
}

/**
 * Anything malformed, or a record for another server or device, reads as empty. Losing the record
 * only costs one full upload, so it never blocks a sync.
 */
export function parseUploadRecord(raw: unknown, target: string): UploadRecord {
  const empty = emptyUploadRecord(target);
  if (typeof raw !== 'object' || raw === null) return empty;
  const fields = raw as Record<string, unknown>;
  if (fields['version'] !== UPLOAD_RECORD_VERSION || fields['target'] !== target) return empty;
  const rawSources = fields['sources'];
  if (typeof rawSources !== 'object' || rawSources === null) return empty;

  const sources: UploadRecord['sources'] = {};
  for (const [source, rawDays] of Object.entries(rawSources as Record<string, unknown>)) {
    if (!isKnownSource(source) || typeof rawDays !== 'object' || rawDays === null) continue;
    const days: Record<string, UploadedDay> = {};
    for (const [date, value] of Object.entries(rawDays as Record<string, unknown>)) {
      const day = readDay(value);
      if (day && isDateKey(date)) days[date] = day;
    }
    sources[source] = days;
  }
  return { version: UPLOAD_RECORD_VERSION, target, sources };
}

export async function readUploadRecord(path: string, target: string): Promise<UploadRecord> {
  try {
    return parseUploadRecord(JSON.parse(await readFile(path, 'utf8')), target);
  } catch {
    return emptyUploadRecord(target);
  }
}

let writeCounter = 0;

export async function writeUploadRecord(path: string, record: UploadRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.${writeCounter++}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, path);
}
