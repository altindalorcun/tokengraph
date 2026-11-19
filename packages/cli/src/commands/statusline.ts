import { spawn } from 'node:child_process';
import { CLAUDE_CODE_SOURCE, CLAUDE_WINDOW_MINUTES, type LimitReading, type LimitWindowReading } from '@tokengraph/core';
import { readConfigSync } from '../config.js';
import { storeClaudeReading } from '../limits/store.js';

/**
 * `tokengraph statusline`: Claude Code's `statusLine` command while `tokengraph limits on` is in force. It saves
 * the limit readings Claude Code passes on stdin and runs the user's own status line command (if there was one)
 * with the same input, printing its output unchanged. It prints nothing of its own and never writes to stderr.
 * Keep this path light: no adapter, ledger or update-check code runs here, because Claude Code calls it often.
 */

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// `"<node>" "<…tokengraph…bin.js>" statusline`, exactly: the same shape as the hook command.
const OUR_COMMAND = /^"[^"]+" "[^"]*token-?graph[^"]*bin\.js" statusline$/;

export function isTokenGraphStatuslineCommand(command: string): boolean {
  return OUR_COMMAND.test(command.trim());
}

/** The limit reading in Claude Code's status line input (`rate_limits.<window>.used_percentage` / `resets_at`), or null. */
export function claudeReadingFromStatusline(input: unknown, now: Date): LimitReading | null {
  if (!isObject(input) || !isObject(input['rate_limits'])) return null;
  const windows: LimitWindowReading[] = [];
  for (const [id, raw] of Object.entries(input['rate_limits'])) {
    if (!isObject(raw) || !finite(raw['used_percentage']) || !finite(raw['resets_at'])) continue;
    windows.push({ id, minutes: CLAUDE_WINDOW_MINUTES[id] ?? null, usedPercent: raw['used_percentage'], resetsAt: new Date(raw['resets_at'] * 1000).toISOString() });
  }
  if (windows.length === 0) return null;
  return { source: CLAUDE_CODE_SOURCE, limitId: null, plan: null, origin: 'statusline', readAt: now.toISOString(), credits: null, windows };
}

export interface StatuslineDeps {
  stdin: () => Promise<Buffer>;
  now: () => Date;
  /** The `statusLine` setting that was there before ours, from `config.json`. */
  previous: () => Record<string, unknown> | null;
  store: (reading: LimitReading) => Promise<boolean>;
  write: (bytes: Buffer) => void;
  spawnShell: (command: string, input: Buffer) => Promise<{ stdout: Buffer; code: number }>;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Runs `command` through the platform shell, as Claude Code would, with `input` on stdin; its stderr is dropped. */
function spawnShell(command: string, input: Buffer): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve({ stdout: Buffer.alloc(0), code: 1 });
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve({ stdout: Buffer.concat(chunks), code: 1 }));
    child.on('close', (code) => resolve({ stdout: Buffer.concat(chunks), code: code ?? 1 }));
    // A command that does not read its input closes the pipe early; that is not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

const DEFAULT_DEPS: StatuslineDeps = {
  stdin: readStdin,
  now: () => new Date(),
  previous: () => {
    try {
      return readConfigSync().claudeStatusline?.previous ?? null;
    } catch {
      return null;
    }
  },
  store: (reading) => storeClaudeReading(reading),
  write: (bytes) => {
    process.stdout.write(bytes);
  },
  spawnShell,
};

export async function runStatusline(overrides: Partial<StatuslineDeps> = {}): Promise<number> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const input = await deps.stdin().catch(() => Buffer.alloc(0));
  try {
    const reading = claudeReadingFromStatusline(JSON.parse(input.toString('utf8')), deps.now());
    if (reading) await deps.store(reading);
  } catch {
    // Not JSON, or the store failed: the user's status line must still show.
  }
  const command = deps.previous()?.['command'];
  if (typeof command !== 'string' || command.trim() === '' || isTokenGraphStatuslineCommand(command)) return 0;
  const { stdout, code } = await deps.spawnShell(command, input);
  if (stdout.length > 0) deps.write(stdout);
  return code;
}
