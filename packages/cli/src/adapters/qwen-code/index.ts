import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { QWEN_CODE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { childDirectories, isDirectory, jsonlFiles, readLines } from '../jsonl-files.js';
import { asObject, nonEmptyString } from '../usage-fields.js';
import { combineQwenSources, parseJsonObjects, QwenLedgerAggregator, QwenUsageAggregator, type QwenAggregatorOptions, type QwenDiagnostics } from './aggregator.js';

/** Qwen Code resolves `~` and relative paths in its path settings; so does this. */
function resolvePath(path: string): string {
  if (path === '~') return homedir();
  return resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}

/** `$QWEN_HOME` (the `.qwen` folder itself, not its parent) when set, else `~/.qwen`; the same on every OS. */
export function qwenHome(): string {
  const override = process.env['QWEN_HOME'];
  return override ? resolvePath(override) : join(homedir(), '.qwen');
}

/** Where Qwen Code reads its user settings. */
export function qwenSettingsPath(): string {
  return join(qwenHome(), 'settings.json');
}

/**
 * Where per-project transcripts live: `<runtime dir>/projects`, with `$QWEN_RUNTIME_DIR` as the
 * runtime dir when set and the Qwen home otherwise. Both are read, since sessions recorded before
 * the variable was set stay in the home. A runtime dir set in settings.json is not followed.
 */
export function qwenProjectsDirs(): string[] {
  return runtimeSubdirs('projects');
}

/** Where Qwen Code's own usage ledger lives: `<runtime dir>/usage`, in the same dirs as the projects. */
export function qwenUsageDirs(): string[] {
  return runtimeSubdirs('usage');
}

function runtimeSubdirs(name: string): string[] {
  const runtime = process.env['QWEN_RUNTIME_DIR'];
  const dirs = [...(runtime ? [resolvePath(runtime)] : []), qwenHome()].map((dir) => join(dir, name));
  return [...new Set(dirs)];
}

/**
 * The model a background subagent ran with. Its transcript records carry no `model`, but its
 * `agent-<id>.meta.json` sidecar names one: `model` for a background launch, or the launch flags'
 * `model` for a foreground one. Only that field is read; the sidecar's description is never kept.
 */
async function subagentModel(transcriptPath: string): Promise<string | null> {
  try {
    const meta = asObject(JSON.parse(await readFile(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')));
    return nonEmptyString(meta?.['model']) ?? nonEmptyString(asObject(meta?.['persistedCliFlags'])?.['model']);
  } catch {
    return null;
  }
}

async function readTranscript(path: string, fallbackModel: string | null, aggregator: QwenUsageAggregator): Promise<void> {
  try {
    await readLines(path, (line) => {
      for (const record of parseJsonObjects(line)) aggregator.addRecord(record, fallbackModel);
    });
  } catch {
    aggregator.noteUnreadableFile();
  }
}

const LEDGER_FILE = /^token-usage-(\d{4})-(\d{2})\.jsonl$/;

/** Whether a ledger file holds no request on or after `since`; the file name's month is Qwen's local one. */
function ledgerFileBeforeSince(path: string, since: Date): boolean {
  const match = LEDGER_FILE.exec(basename(path));
  if (!match) return true;
  // A day of slack, since the file's local month can trail the UTC month by up to a day.
  const cutoff = new Date(since.getTime() - 24 * 60 * 60 * 1000);
  return `${match[1]}-${match[2]}` < cutoff.toISOString().slice(0, 7);
}

async function readLedger(path: string, aggregator: QwenLedgerAggregator): Promise<void> {
  try {
    await readLines(path, (line) => {
      for (const record of parseJsonObjects(line)) aggregator.addRecord(record);
    });
  } catch {
    aggregator.noteUnreadableFile();
  }
}

function sumDiagnostics(a: QwenDiagnostics, b: QwenDiagnostics): QwenDiagnostics {
  return {
    malformedRecords: a.malformedRecords + b.malformedRecords,
    clampedRecords: a.clampedRecords + b.clampedRecords,
    unreadableFiles: a.unreadableFiles + b.unreadableFiles,
    unknownSchemaRecords: a.unknownSchemaRecords + b.unknownSchemaRecords,
  };
}

function describeDiagnostics({ malformedRecords, clampedRecords, unreadableFiles, unknownSchemaRecords }: QwenDiagnostics): string[] {
  const notes: string[] = [];
  if (malformedRecords > 0) notes.push(`skipped ${malformedRecords} Qwen Code record(s) with missing or invalid token counts, uuid or timestamp`);
  if (clampedRecords > 0) notes.push(`${clampedRecords} Qwen Code record(s) reported more cached than prompt tokens; counted as 0 fresh input`);
  if (unknownSchemaRecords > 0) notes.push(`skipped ${unknownSchemaRecords} Qwen Code usage ledger record(s) with an unknown schemaVersion`);
  if (unreadableFiles > 0) notes.push(`${unreadableFiles} session file(s) could not be read`);
  return notes;
}

/**
 * Reads Qwen Code's chat transcripts: `projects/<cwd>/chats/<session>.jsonl`, plus the background
 * subagents' `projects/<cwd>/subagents/<session>/agent-<id>.jsonl`. Only the usage counters,
 * model, uuid and timestamp of a record are read; message text, tool output and working
 * directories are never kept. Recording can be switched off in Qwen Code (`general.chatRecording`).
 *
 * Qwen Code 0.19.0 and later also write `usage/token-usage-YYYY-MM.jsonl`, one line per model
 * request, including the managed memory extractor's, which the chats do not hold. Both sources are
 * read and, for each day, the one with more weighted tokens is used (see `combineQwenSources`).
 */
export function createQwenCodeAdapter(options: Pick<QwenAggregatorOptions, 'timeZone'> = {}): Adapter {
  return {
    name: QWEN_CODE_SOURCE,

    async detect(): Promise<boolean> {
      for (const dir of [...qwenProjectsDirs(), ...qwenUsageDirs()]) if (await isDirectory(dir)) return true;
      return false;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new QwenUsageAggregator({ ...options, since });
      for (const projectsDir of qwenProjectsDirs()) {
        for (const projectDir of await childDirectories(projectsDir)) {
          for (const [folder, hasMeta] of [['chats', false], ['subagents', true]] as const) {
            for await (const path of jsonlFiles(join(projectDir, folder))) {
              // A file last written before the cutoff cannot hold requests after it.
              const info = await stat(path).catch(() => null);
              if (!info || info.mtime < since) continue;
              await readTranscript(path, hasMeta ? await subagentModel(path) : null, aggregator);
            }
          }
        }
      }

      const ledger = new QwenLedgerAggregator({ ...options, since });
      for (const usageDir of qwenUsageDirs()) {
        for await (const path of jsonlFiles(usageDir)) {
          if (!ledgerFileBeforeSince(path, since)) await readLedger(path, ledger);
        }
      }

      const notes = describeDiagnostics(sumDiagnostics(aggregator.diagnostics(), ledger.diagnostics()));
      return { ...combineQwenSources(aggregator.result(), ledger.result()), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
