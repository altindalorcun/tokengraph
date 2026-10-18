import type { Adapter, CollectResult } from '@tokengraph/core';
import { createClaudeCodeAdapter, projectsDir } from './adapters/claude-code/index.js';
import { clineSessionsDir, createClineAdapter } from './adapters/cline/index.js';
import { codexSessionsDir, createCodexAdapter } from './adapters/codex/index.js';
import { createCursorAdapter, cursorEventsPath } from './adapters/cursor/index.js';
import { createGeminiCliAdapter, geminiTmpDirs } from './adapters/gemini-cli/index.js';
import { createKiloAdapter, kiloDataDir } from './adapters/kilo/index.js';
import { createOpenCodeAdapter, openCodeDataDir } from './adapters/opencode/index.js';
import { mergeUsage, type Ledger } from './ledger.js';

export interface CollectProgress {
  adapter: string;
  state: 'scanning' | 'done' | 'failed';
  message?: string;
}

export interface LocalCollection {
  ledger: Ledger;
  results: CollectResult[];
  failures: { adapter: string; message: string }[];
  detected: string[];
}

/** Every adapter the CLI knows, in the order sync reports them. */
export function defaultAdapters(): Adapter[] {
  return [
    createClaudeCodeAdapter(),
    createCodexAdapter(),
    createCursorAdapter(),
    createGeminiCliAdapter(),
    createClineAdapter(),
    createOpenCodeAdapter(),
    createKiloAdapter(),
  ];
}

/**
 * Detects and collects every adapter, merging into `ledger` (max-merge, so it never shrinks). Never writes the
 * ledger, publishes or prints: callers decide what to do with the result.
 */
export async function collectLocal(
  ledger: Ledger,
  since: Date,
  options: { adapters?: Adapter[]; onProgress?: (progress: CollectProgress) => void } = {},
): Promise<LocalCollection> {
  const adapters = options.adapters ?? defaultAdapters();
  const onProgress = options.onProgress ?? (() => {});
  const detected: Adapter[] = [];
  for (const adapter of adapters) if (await adapter.detect()) detected.push(adapter);

  const results: CollectResult[] = [];
  const failures: { adapter: string; message: string }[] = [];
  for (const adapter of detected) {
    onProgress({ adapter: adapter.name, state: 'scanning' });
    try {
      const result = await adapter.collect(since);
      ledger = mergeUsage(ledger, result.source, result.usage);
      results.push(result);
      onProgress({ adapter: adapter.name, state: 'done' });
    } catch (error) {
      // One adapter's local files being unreadable (corrupt, permissions, an out-of-range value
      // its own guards didn't anticipate) must not lose the other adapters' data for this run.
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ adapter: adapter.name, message });
      onProgress({ adapter: adapter.name, state: 'failed', message });
    }
  }
  return { ledger, results, failures, detected: detected.map((adapter) => adapter.name) };
}

/** One line per place that was searched, e.g. "~/.claude/projects (Claude Code)". */
export function searchedPaths(): string[] {
  return [
    `${projectsDir()} (Claude Code)`,
    `${codexSessionsDir()} (Codex CLI)`,
    `${cursorEventsPath()} (Cursor — run \`tokengraph install-hook --agent cursor\` to start recording)`,
    `${geminiTmpDirs()[0]} (Gemini CLI)`,
    `${clineSessionsDir()} and VS Code's Cline storage (Cline)`,
    `${openCodeDataDir()} (OpenCode)`,
    `${kiloDataDir()} (Kilo CLI)`,
  ];
}

/** Sync's "No agent usage found…" text, shared with the view's empty state. */
export function noAgentsMessage(): string {
  return (
    'No agent usage found. Looked for Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode and Kilo CLI data:\n' +
    searchedPaths()
      .map((line) => `  ${line}`)
      .join('\n')
  );
}
