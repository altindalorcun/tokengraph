import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { QWEN_CODE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { envPath, FileDeduper, pathFor, planScan, processRootContext, type PlannedTarget, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { childDirectories, jsonlFiles, readLines } from '../jsonl-files.js';
import { asObject, nonEmptyString } from '../usage-fields.js';
import { QWEN_ROOTS } from './roots.js';
import { combineQwenSources, parseJsonObjects, QwenLedgerAggregator, QwenUsageAggregator, type QwenAggregatorOptions, type QwenDiagnostics } from './aggregator.js';

/** `$QWEN_HOME` (the `.qwen` folder itself, not its parent; `~` expanded, absolute) when this process's environment sets it, else `~/.qwen`; the same on every OS. */
export function qwenHome(): string {
  const ctx = processRootContext();
  return envPath(ctx, 'QWEN_HOME') ?? pathFor(ctx.platform).join(ctx.home, '.qwen');
}

/** Where Qwen Code reads its user settings. */
export function qwenSettingsPath(): string {
  return join(qwenHome(), 'settings.json');
}

/**
 * Where per-project transcripts live for this process's environment: `<runtime dir>/projects`, with
 * `$QWEN_RUNTIME_DIR` as the runtime dir when set and the Qwen home otherwise. Both are read, since
 * sessions recorded before the variable was set stay in the home. A runtime dir set in settings.json
 * is not followed. The adapter also reads the default home and remembered ones.
 */
export function qwenProjectsDirs(): string[] {
  return runtimeSubdirs('projects');
}

/** Where Qwen Code's own usage ledger lives: `<runtime dir>/usage`, in the same dirs as the projects. */
export function qwenUsageDirs(): string[] {
  return runtimeSubdirs('usage');
}

function runtimeSubdirs(name: string): string[] {
  const ctx = processRootContext();
  const roots = [...QWEN_ROOTS.fromEnv(ctx), qwenHome()];
  return [...new Set(roots.map((root) => pathFor(ctx.platform).join(root, name)))];
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
export interface QwenCodeAdapterOptions extends Pick<QwenAggregatorOptions, 'timeZone'>, RootsOption {}

export function createQwenCodeAdapter(adapterOptions: QwenCodeAdapterOptions = {}): Adapter {
  const { roots, ...options } = adapterOptions;
  const plan = async (kind: 'projects' | 'usage'): Promise<string[]> => {
    const { ctx, remembered } = await resolveAdapterRoots(QWEN_ROOTS, roots);
    const targets: PlannedTarget[] = (await planScan(QWEN_ROOTS, ctx, remembered)).filter((target) => target.exists && target.kind === kind);
    return targets.map((target) => target.path);
  };

  return {
    name: QWEN_CODE_SOURCE,

    async detect(): Promise<boolean> {
      return (await plan('projects')).length + (await plan('usage')).length > 0;
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new QwenUsageAggregator({ ...options, since });
      const files = new FileDeduper();
      for (const projectsDir of await plan('projects')) {
        for (const projectDir of await childDirectories(projectsDir)) {
          for (const [folder, hasMeta] of [['chats', false], ['subagents', true]] as const) {
            for await (const path of jsonlFiles(join(projectDir, folder))) {
              // A file last written before the cutoff cannot hold requests after it.
              const info = await stat(path).catch(() => null);
              if (!info || info.mtime < since) continue;
              if (!(await files.first(path))) continue;
              await readTranscript(path, hasMeta ? await subagentModel(path) : null, aggregator);
            }
          }
        }
      }

      const ledger = new QwenLedgerAggregator({ ...options, since });
      for (const usageDir of await plan('usage')) {
        for await (const path of jsonlFiles(usageDir)) {
          if (!ledgerFileBeforeSince(path, since) && (await files.first(path))) await readLedger(path, ledger);
        }
      }

      const notes = describeDiagnostics(sumDiagnostics(aggregator.diagnostics(), ledger.diagnostics()));
      return { ...combineQwenSources(aggregator.result(), ledger.result()), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
