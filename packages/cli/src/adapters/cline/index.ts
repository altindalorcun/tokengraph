import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CLINE_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { envPath, pathFor, planScan, processRootContext, type RootsOption } from '../../agent-roots.js';
import { resolveAdapterRoots } from '../../agent-roots-store.js';
import { RequestBuckets } from '../request-buckets.js';
import { addClassicTask, type ClassicTask } from './classic.js';
import { emptyClineDiagnostics, type ClineDiagnostics } from './normalize.js';
import { CLINE_ROOTS, clineSdkHome } from './roots.js';
import { addSdkMessages, learnExclusiveModels } from './sdk.js';

/** Where this process's environment puts Cline's SDK sessions: `CLINE_SESSION_DATA_DIR`, else `<data dir>/sessions` (`~/.cline/data/sessions` by default). */
export function clineSessionsDir(): string {
  const ctx = processRootContext();
  const path = pathFor(ctx.platform);
  const dataDir = envPath(ctx, 'CLINE_DATA_DIR') ?? path.join(envPath(ctx, 'CLINE_DIR') ?? path.join(clineSdkHome(ctx) ?? ctx.home, '.cline'), 'data');
  return envPath(ctx, 'CLINE_SESSION_DATA_DIR') ?? path.join(dataDir, 'sessions');
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

/** Parses a JSON file that is optional or whose shape we cannot fully trust; failure means null, never thrown. */
async function readJsonFileOrNull(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reads one classic task directory's `ui_messages.json` (falling back to the older
 * `claude_messages.json` name) plus its optional `task_metadata.json`. Returns null when there is
 * no messages file, the file predates `since`, or it cannot be read at all (counted as unreadable).
 */
async function readClassicTask(taskDir: string, taskId: string, since: Date, diagnostics: ClineDiagnostics): Promise<ClassicTask | null> {
  let messagesPath = join(taskDir, 'ui_messages.json');
  let info = await stat(messagesPath).catch(() => null);
  if (!info) {
    messagesPath = join(taskDir, 'claude_messages.json');
    info = await stat(messagesPath).catch(() => null);
  }
  if (!info || info.mtime < since) return null;

  let messages: unknown;
  try {
    messages = JSON.parse(await readFile(messagesPath, 'utf8'));
  } catch {
    diagnostics.unreadableFiles += 1;
    return null;
  }
  if (!Array.isArray(messages)) {
    diagnostics.unreadableFiles += 1;
    return null;
  }
  const metadata = await readJsonFileOrNull(join(taskDir, 'task_metadata.json'));
  return { taskId, messages, metadata };
}

/** `.messages.json` files directly under a session directory: the main agent's and any subagents'. Never `.compaction.json`, `providers.json`, `secrets.json` or `globalState.json` — none of those end in `.messages.json`. */
async function sessionMessageFiles(sessionDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.messages.json'))
    .map((entry) => join(sessionDir, entry.name));
}

/** Parsed `.messages.json` files of one session that are new enough, one at a time (never all held at once). */
async function* sdkSessionDocuments(sessionDir: string, since: Date, diagnostics: ClineDiagnostics): AsyncGenerator<unknown> {
  for (const path of await sessionMessageFiles(sessionDir)) {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtime < since) continue;
    try {
      yield JSON.parse(await readFile(path, 'utf8'));
    } catch {
      diagnostics.unreadableFiles += 1;
    }
  }
}

/** First pass over one session: learn which models report cache-exclusive input. Unreadable files are counted in the second pass only. */
async function learnSdkSession(sessionDir: string, since: Date, learned: Set<string>): Promise<void> {
  for await (const document of sdkSessionDocuments(sessionDir, since, emptyClineDiagnostics())) {
    learnExclusiveModels(document, learned);
  }
}

async function readSdkSession(
  sessionDir: string,
  sessionId: string,
  since: Date,
  buckets: RequestBuckets,
  diagnostics: ClineDiagnostics,
  options: { since?: Date; timeZone?: string },
  learned: ReadonlySet<string>,
): Promise<void> {
  const manifest = await readJsonFileOrNull(join(sessionDir, `${sessionId}.json`));
  for await (const document of sdkSessionDocuments(sessionDir, since, diagnostics)) {
    addSdkMessages({ document, manifest }, buckets, diagnostics, options, learned);
  }
}

function describeDiagnostics(d: ClineDiagnostics): string[] {
  const notes: string[] = [];
  if (d.skippedClaudeCode > 0) {
    notes.push(`skipped ${d.skippedClaudeCode} request(s) made through the claude-code provider (already counted from Claude Code)`);
  }
  if (d.skippedEstimated > 0) notes.push(`skipped ${d.skippedEstimated} Bedrock request(s) whose counts Cline estimates`);
  if (d.skippedImported > 0) notes.push(`skipped ${d.skippedImported} message(s) imported from another tool`);
  if (d.skippedLegacyCopies > 0) notes.push(`skipped ${d.skippedLegacyCopies} message(s) copied from an older Cline task`);
  if (d.exclusiveDetected > 0) {
    notes.push(`${d.exclusiveDetected} request(s) report input excluding cache; counted as fresh input`);
  }
  if (d.clamped > 0) notes.push(`${d.clamped} request(s) reported more cached than total input; counted as 0 fresh input`);
  if (d.unreadableFiles > 0) notes.push(`${d.unreadableFiles} Cline file(s) could not be read`);
  if (d.malformedEntries > 0) notes.push(`skipped ${d.malformedEntries} malformed Cline usage record(s)`);
  return notes;
}

/**
 * Reads Cline's two local usage formats: classic per-task `ui_messages.json` files (extension
 * versions up to and including today's "legacy" package) and SDK per-session `.messages.json`
 * files (today's "next" package and the Cline CLI). Only counters, ids, model/provider ids and
 * timestamps are ever read; `providers.json`, `secrets.json` and `globalState.json` — which hold
 * API keys — are never opened, and prompt/response text is never kept even when it is right next to
 * a counter we do read.
 */
export interface ClineAdapterOptions extends RootsOption {
  timeZone?: string;
}

export function createClineAdapter(adapterOptions: ClineAdapterOptions = {}): Adapter {
  const { roots, ...options } = adapterOptions;
  /** The folders that exist: classic `tasks` folders and SDK `sessions` folders, each real folder once. */
  const plan = async (): Promise<{ tasks: string[]; sessions: string[] }> => {
    const { ctx, remembered } = await resolveAdapterRoots(CLINE_ROOTS, roots);
    const existing = (await planScan(CLINE_ROOTS, ctx, remembered)).filter((target) => target.exists);
    return {
      tasks: existing.filter((target) => target.kind === 'tasks').map((target) => target.path),
      sessions: existing.filter((target) => target.kind === 'sessions').map((target) => target.path),
    };
  };

  return {
    name: CLINE_SOURCE,

    async detect(): Promise<boolean> {
      const { tasks, sessions } = await plan();
      return tasks.length + sessions.length > 0;
    },

    async collect(since: Date): Promise<CollectResult> {
      const buckets = new RequestBuckets();
      const diagnostics = emptyClineDiagnostics();
      const taskOptions = { since, timeZone: options.timeZone };

      const { tasks, sessions } = await plan();

      for (const tasksDir of tasks) {
        for (const taskId of await subdirectoryNames(tasksDir)) {
          const task = await readClassicTask(join(tasksDir, taskId), taskId, since, diagnostics);
          if (task) addClassicTask(task, buckets, diagnostics, taskOptions);
        }
      }

      const sessionFolders: { dir: string; id: string }[] = [];
      for (const sessionsDir of sessions) {
        for (const id of await subdirectoryNames(sessionsDir)) sessionFolders.push({ dir: join(sessionsDir, id), id });
      }
      // Pass 1: a model that reports cache-exclusive input on any row is exclusive on all its rows.
      const learned = new Set<string>();
      for (const { dir } of sessionFolders) await learnSdkSession(dir, since, learned);
      for (const { dir, id } of sessionFolders) await readSdkSession(dir, id, since, buckets, diagnostics, taskOptions, learned);

      const notes = describeDiagnostics(diagnostics);
      return {
        source: CLINE_SOURCE,
        usage: buckets.toUsage(),
        requestCount: buckets.size,
        ...(notes.length > 0 ? { notes } : {}),
      };
    },
  };
}
