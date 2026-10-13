import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_CLI_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { readLines } from '../jsonl-files.js';
import { GeminiUsageAggregator, type GeminiAggregatorOptions, type GeminiDiagnostics } from './aggregator.js';

function geminiHome(): string {
  return process.env['GEMINI_CLI_HOME'] ?? homedir();
}

/** Where Gemini CLI keeps chat recordings: its runtime dir, plus the macOS sandbox's copy. */
export function geminiTmpDirs(): string[] {
  return [join(geminiHome(), '.gemini', 'tmp'), join(homedir(), '.cache', '.gemini', 'tmp')];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Directories directly under a tmp dir — one per Gemini CLI project (hash or slug). */
async function projectDirs(tmpDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(tmpDir, entry.name));
}

/**
 * `.jsonl` and `.json` files under a project's `chats/` directory, recursively (subagent sessions
 * live one level deeper, in `chats/<parentSessionId>/`). Nothing outside `chats/` is walked, so
 * `logs.json`, `checkpoint-*.json` and anything else at the project's root is never opened.
 */
async function* sessionFiles(chatsDir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(chatsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(chatsDir, entry.name);
    if (entry.isDirectory()) {
      yield* sessionFiles(path);
    } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
      yield path;
    }
  }
}

function hasMessagesArray(value: unknown): value is { messages: unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)['messages']);
}

async function readJsonlSession(path: string, aggregator: GeminiUsageAggregator): Promise<void> {
  try {
    await readLines(path, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        // A bad line (e.g. a partial write) is skipped silently, not counted as unreadable.
        return;
      }
      aggregator.addRecord(record);
    });
  } catch {
    aggregator.noteUnreadableFile();
  }
}

async function readLegacyJsonSession(path: string, aggregator: GeminiUsageAggregator): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (hasMessagesArray(parsed)) aggregator.addDocument(parsed);
    else aggregator.addRecord(parsed);
  } catch {
    aggregator.noteUnreadableFile();
  }
}

function describeDiagnostics({ malformedMessages, clampedMessages, totalMismatches, unreadableFiles }: GeminiDiagnostics): string[] {
  const notes: string[] = [];
  if (malformedMessages > 0) notes.push(`skipped ${malformedMessages} Gemini message(s) with missing token counts`);
  if (clampedMessages > 0) {
    notes.push(`${clampedMessages} message(s) reported more cached than total input; counted as 0 fresh input`);
  }
  if (totalMismatches > 0) notes.push(`${totalMismatches} message(s) had a total that did not match their parts (counted as recorded)`);
  if (unreadableFiles > 0) notes.push(`${unreadableFiles} session file(s) could not be read`);
  return notes;
}

/**
 * Reads Gemini CLI's local chat recordings. Recording is always on (no opt-out); only the counters
 * inside each message's `tokens` object are read — prompt/response text, tool output and
 * directories are never opened or stored.
 */
export function createGeminiCliAdapter(options: Pick<GeminiAggregatorOptions, 'timeZone'> = {}): Adapter {
  return {
    name: GEMINI_CLI_SOURCE,

    async detect(): Promise<boolean> {
      for (const dir of geminiTmpDirs()) if (await isDirectory(dir)) return true;
      return false;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new GeminiUsageAggregator({ ...options, since });
      for (const tmpDir of geminiTmpDirs()) {
        for (const projectDir of await projectDirs(tmpDir)) {
          for await (const path of sessionFiles(join(projectDir, 'chats'))) {
            const info = await stat(path).catch(() => null);
            if (!info || info.mtime < since) continue;
            if (path.endsWith('.jsonl')) await readJsonlSession(path, aggregator);
            else await readLegacyJsonSession(path, aggregator);
          }
        }
      }
      const notes = describeDiagnostics(aggregator.diagnostics());
      return { ...aggregator.result(), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
