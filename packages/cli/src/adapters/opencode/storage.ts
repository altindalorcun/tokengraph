import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { OpenCodeAggregator } from './aggregator.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asMsOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function subdirectoryNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function jsonFileNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
}

/** Parses a JSON file we cannot fully trust; a read or parse failure is reported by the caller, never thrown. */
async function readJsonFile(path: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

async function readSessions(storageDir: string, aggregator: OpenCodeAggregator): Promise<void> {
  const sessionRoot = join(storageDir, 'session');
  for (const projectId of await subdirectoryNames(sessionRoot)) {
    const dir = join(sessionRoot, projectId);
    for (const file of await jsonFileNames(dir)) {
      const parsed = await readJsonFile(join(dir, file));
      const raw = parsed.ok ? asRecord(parsed.value) : null;
      if (!raw) {
        aggregator.noteUnreadableSource();
        continue;
      }
      const time = asRecord(raw['time']);
      aggregator.addSession({
        id: basename(file, '.json'),
        version: asStringOrNull(raw['version']),
        createdMs: asMsOrNull(time?.['created']),
      });
    }
  }
}

/** A message's step-finish parts, sorted by file name (= part id, time-ordered). Read only for assistant messages. */
async function readSteps(storageDir: string, messageId: string, aggregator: OpenCodeAggregator): Promise<unknown[]> {
  const dir = join(storageDir, 'part', messageId);
  const files = (await jsonFileNames(dir)).sort();
  const steps: unknown[] = [];
  for (const file of files) {
    const parsed = await readJsonFile(join(dir, file));
    const raw = parsed.ok ? asRecord(parsed.value) : null;
    if (!raw) {
      aggregator.noteUnreadableSource();
      continue;
    }
    if (raw['type'] !== 'step-finish') continue;
    steps.push(raw['tokens'] ?? null);
  }
  return steps;
}

async function readMessages(storageDir: string, aggregator: OpenCodeAggregator, sinceMs: number): Promise<void> {
  const messageRoot = join(storageDir, 'message');
  for (const sessionId of await subdirectoryNames(messageRoot)) {
    const dir = join(messageRoot, sessionId);
    for (const file of await jsonFileNames(dir)) {
      const path = join(dir, file);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtime.getTime() < sinceMs) continue;

      const parsed = await readJsonFile(path);
      const raw = parsed.ok ? asRecord(parsed.value) : null;
      if (!raw) {
        aggregator.noteUnreadableSource();
        continue;
      }
      if (raw['role'] !== 'assistant') continue;

      const id = basename(file, '.json');
      const steps = await readSteps(storageDir, id, aggregator);
      const hasTokens = raw['tokens'] !== null && raw['tokens'] !== undefined;
      // No steps and no message-level tokens at all: an in-flight or aborted assistant message
      // with nothing to count. Skipped silently rather than passed through as an invalid record.
      if (steps.length === 0 && !hasTokens) continue;

      const time = asRecord(raw['time']);
      aggregator.addV1Message({
        id,
        sessionId,
        providerId: asStringOrNull(raw['providerID']),
        modelId: asStringOrNull(raw['modelID']),
        createdMs: asMsOrNull(time?.['created']) ?? 0,
        completedMs: asMsOrNull(time?.['completed']),
        agent: asStringOrNull(raw['agent']),
        cost: typeof raw['cost'] === 'number' ? raw['cost'] : null,
        tokens: hasTokens ? raw['tokens'] : null,
        steps,
      });
    }
  }
}

/**
 * Reads the pre-1.2 JSON store (`storage/{session,message,part}`, never `auth.json`,
 * `mcp-auth.json` or `log/`) into `aggregator`. Only counters, ids, model/provider ids and
 * timestamps are ever read — never `content`, `path`, `directory` or `title`.
 */
export async function readOpenCodeStorage(storageDir: string, aggregator: OpenCodeAggregator, sinceMs: number): Promise<void> {
  await readSessions(storageDir, aggregator);
  await readMessages(storageDir, aggregator, sinceMs);
}
