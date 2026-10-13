import { join } from 'node:path';
import { codexHome } from './adapters/codex/index.js';
import { binPath } from './bin-path.js';
import { isTokenGraphHookCommand } from './hook-settings.js';
import { stableNodePath } from './node-path.js';

/** Codex fires `notify` after every turn; the hook runs a sync at most this often. */
export const CODEX_MIN_INTERVAL_SECONDS = 600;

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

export function codexNotifyArgs(): string[] {
  return [stableNodePath(process.execPath), binPath(), 'hook-sync', '--min-interval', String(CODEX_MIN_INTERVAL_SECONDS)];
}

export type NotifyEdit =
  | { kind: 'unchanged'; text: string }
  | { kind: 'written'; text: string; replacedOlder: boolean }
  | { kind: 'foreign'; existing: string };

interface NotifyKey {
  /** Index of the first line of the `notify` entry and one past its last. */
  start: number;
  end: number;
  /** The array's string elements (comments ignored). */
  elements: string[];
}

const TABLE_HEADER = /^\s*\[/;
const NOTIFY_KEY = /^\s*notify\s*=/;
// A TOML basic string, or a comment (which is skipped so quotes inside it are not read as elements).
const TOKEN = /"(?:[^"\\]|\\.)*"|#[^\n]*/g;

function parseElements(source: string): string[] {
  const elements: string[] = [];
  for (const token of source.match(TOKEN) ?? []) {
    if (!token.startsWith('"')) continue;
    try {
      elements.push(JSON.parse(token) as string);
    } catch {
      // A TOML escape JSON lacks (e.g. \U0001F600): not something we wrote, so it can only make the entry foreign.
      elements.push(token);
    }
  }
  return elements;
}

/** Finds the top-level `notify` entry: only lines before the first table header count. */
function findNotify(lines: readonly string[]): NotifyKey | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (TABLE_HEADER.test(line)) return undefined;
    if (!NOTIFY_KEY.test(line)) continue;

    let end = i + 1;
    // A multi-line array: the value's `[` has no `]` on its line, so it runs to the first line with one.
    if (line.includes('[') && !line.includes(']')) {
      while (end < lines.length && !(lines[end] ?? '').includes(']')) end += 1;
      end = Math.min(end + 1, lines.length);
    }
    const value = lines.slice(i, end).join('\n').replace(NOTIFY_KEY, '');
    return { start: i, end, elements: parseElements(value) };
  }
  return undefined;
}

function isOurs(elements: readonly string[]): boolean {
  if (elements.length < 2) return false;
  const [node, bin, ...rest] = elements;
  return isTokenGraphHookCommand(`"${node}" "${bin}" ${rest.join(' ')}`);
}

function notifyLine(args: readonly string[]): string {
  // JSON string escaping is valid TOML basic-string escaping.
  return `notify = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`;
}

function lineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Adds our `notify` as the first line, or refreshes ours in place. Never replaces someone else's. */
export function setCodexNotify(text: string, args: readonly string[]): NotifyEdit {
  const eol = lineEnding(text);
  const lines = text.split('\n');
  const found = findNotify(lines);
  const line = notifyLine(args);

  if (found === undefined) return { kind: 'written', text: `${line}${eol}${text}`, replacedOlder: false };
  if (!isOurs(found.elements)) {
    return { kind: 'foreign', existing: lines.slice(found.start, found.end).join('\n').trim() };
  }
  if (found.elements.length === args.length && found.elements.every((element, i) => element === args[i])) {
    return { kind: 'unchanged', text };
  }
  const last = lines[found.end - 1] ?? '';
  const replacement = last.endsWith('\r') ? `${line}\r` : line;
  const next = [...lines.slice(0, found.start), replacement, ...lines.slice(found.end)];
  return { kind: 'written', text: next.join('\n'), replacedOlder: true };
}

/** Removes our `notify`; leaves the file alone when it is absent or belongs to someone else. */
export function removeCodexNotify(text: string): NotifyEdit {
  const lines = text.split('\n');
  const found = findNotify(lines);
  if (found === undefined || !isOurs(found.elements)) return { kind: 'unchanged', text };
  const next = [...lines.slice(0, found.start), ...lines.slice(found.end)];
  return { kind: 'written', text: next.join('\n'), replacedOlder: false };
}
