import { join } from 'node:path';
import { codexHome } from './adapters/codex/index.js';
import { codexNotifyArgs } from './codex-config-toml.js';
import { isTokenGraphHookCommand } from './hook-settings.js';

/**
 * Codex lifecycle hooks (`$CODEX_HOME/hooks.json`), used when Codex's single `notify` slot already belongs to another
 * program (Codex's own Computer Use writes one). Shape, from openai/codex `codex-rs/config/src/hook_config.rs`:
 * `{ "description"?: string, "hooks": { "<Event>": [ { "matcher"?: string, "hooks": [ { "type": "command", ... } ] } ] } }`.
 * The top level allows no other keys (`deny_unknown_fields`). Only tokengraph's own `Stop` handler is ever added,
 * refreshed or removed; everything else in the file is kept as it is. See docs/agents/codex-usage.md.
 */
export type CodexHooksFile = Record<string, unknown>;

/** Fires once at the end of every turn (Codex `HookEventName::Stop`). */
export const CODEX_HOOK_EVENT = 'Stop';
/** The key Codex uses for the event in `hooks.state` keys (`hook_event_key_label`). */
const CODEX_HOOK_EVENT_KEY = 'stop';
/**
 * The handler's `statusMessage`: Codex's /hooks list shows it as the hook's name (else "Unnamed hook"), and Codex
 * shows it while the hook runs.
 */
export const CODEX_HOOK_NAME = 'tokengraph: sync usage';
/** Seconds; hook-sync returns in well under one. Codex's default is 600. */
export const CODEX_HOOK_TIMEOUT_SECONDS = 30;
/** The first release with hooks stable and on by default (`Feature::CodexHooks`, then keyed `codex_hooks`). */
export const CODEX_HOOKS_MIN_VERSION = '0.124.0';

export function codexHooksPath(): string {
  return join(codexHome(), 'hooks.json');
}

/**
 * The same program as our notify (`hook-sync --min-interval 600`), as one command line. Codex runs it with
 * `$SHELL -lc` (cmd.exe /C on Windows), where the two quoted paths work as they do for the Claude Code hook.
 */
export function codexHookCommand(args: readonly string[] = codexNotifyArgs()): string {
  const [node, bin, ...rest] = args;
  return [`"${node}"`, `"${bin}"`, ...rest].join(' ');
}

interface Handler {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [field: string]: unknown;
}

interface Group {
  matcher?: unknown;
  hooks?: unknown;
  [field: string]: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Why the file cannot be edited safely (a shape Codex would reject, or that we would have to guess about), else null. */
export function codexHooksFileProblem(file: unknown): string | null {
  if (!isObject(file)) return 'it does not contain a JSON object';
  if (file['hooks'] === undefined) return null;
  if (!isObject(file['hooks'])) return '"hooks" is not an object';
  const stop = file['hooks'][CODEX_HOOK_EVENT];
  if (stop === undefined) return null;
  if (!Array.isArray(stop)) return `"hooks.${CODEX_HOOK_EVENT}" is not a list`;
  for (const group of stop) {
    if (!isObject(group)) return `"hooks.${CODEX_HOOK_EVENT}" holds an entry that is not an object`;
    if (group['hooks'] !== undefined && !Array.isArray(group['hooks'])) return `"hooks.${CODEX_HOOK_EVENT}" holds an entry whose "hooks" is not a list`;
  }
  return null;
}

function stopGroups(file: CodexHooksFile): Group[] {
  const hooks = file['hooks'];
  const stop = isObject(hooks) ? hooks[CODEX_HOOK_EVENT] : undefined;
  return Array.isArray(stop) ? (stop as Group[]) : [];
}

function handlersOf(group: Group): Handler[] {
  return Array.isArray(group?.hooks) ? (group.hooks as Handler[]) : [];
}

const isOurs = (handler: Handler): boolean => typeof handler?.command === 'string' && isTokenGraphHookCommand(handler.command);

export interface CodexHookPosition {
  group: number;
  handler: number;
  command: string;
}

/** Every tokengraph handler on `Stop`, with its position (which Codex's trust key is built from). */
export function codexHookPositions(file: CodexHooksFile): CodexHookPosition[] {
  return stopGroups(file).flatMap((group, g) =>
    handlersOf(group).flatMap((handler, h) => (isOurs(handler) ? [{ group: g, handler: h, command: handler.command as string }] : [])),
  );
}

function withStop(file: CodexHooksFile, groups: Group[]): CodexHooksFile {
  const hooks = { ...(isObject(file['hooks']) ? file['hooks'] : {}) };
  if (groups.length > 0) hooks[CODEX_HOOK_EVENT] = groups;
  else delete hooks[CODEX_HOOK_EVENT];
  if (Object.keys(hooks).length > 0) return { ...file, hooks };
  const { hooks: _emptied, ...rest } = file;
  return rest;
}

/**
 * Removes our handlers except the one at `keep`. Codex keys each hook's approval by its position
 * (`<file>:stop:<group>:<handler>`), so a group we empty stays as `{ "hooks": [] }` when groups follow it: dropping
 * it would shift those groups and Codex would stop trusting them. Only trailing groups we emptied are dropped.
 */
function withoutOurs(groups: readonly Group[], keep?: CodexHookPosition): Group[] {
  const emptied = new Set<number>();
  const next = groups.map((group, g) => {
    const handlers = handlersOf(group);
    const kept = handlers.filter((handler, h) => !isOurs(handler) || (keep?.group === g && keep.handler === h));
    if (kept.length === handlers.length) return group;
    if (kept.length === 0) emptied.add(g);
    return { ...group, hooks: kept };
  });
  while (next.length > 0 && emptied.has(next.length - 1)) next.pop();
  return next;
}

export type CodexHooksEdit =
  | { kind: 'unchanged' }
  /** `file: null` means nothing is left: the file only ever held our hook. */
  | { kind: 'written'; file: CodexHooksFile | null; replacedOlder: boolean };

function ourHandler(command: string, previous: Handler = {}): Handler {
  return { ...previous, type: 'command', command, timeout: CODEX_HOOK_TIMEOUT_SECONDS, statusMessage: CODEX_HOOK_NAME };
}

/** Adds our `Stop` handler at the end, or refreshes an older one in place (same position, so it keeps its key). */
export function addCodexHook(file: CodexHooksFile, command: string): CodexHooksEdit {
  const positions = codexHookPositions(file);
  const groups = stopGroups(file);
  const first = positions[0];
  if (first === undefined) {
    return { kind: 'written', file: withStop(file, [...groups, { hooks: [ourHandler(command)] }]), replacedOlder: false };
  }
  const current = handlersOf(groups[first.group]!)[first.handler]!;
  const fresh = ourHandler(command, current);
  const same =
    positions.length === 1 &&
    current.command === command &&
    current.type === 'command' &&
    current.timeout === fresh.timeout &&
    current.statusMessage === fresh.statusMessage;
  if (same) return { kind: 'unchanged' };
  const refreshed = withoutOurs(groups, first).map((group, g) =>
    g === first.group ? { ...group, hooks: handlersOf(group).map((handler, h) => (h === first.handler ? fresh : handler)) } : group,
  );
  return { kind: 'written', file: withStop(file, refreshed), replacedOlder: true };
}

/** Removes every tokengraph `Stop` handler and nothing else. */
export function removeCodexHook(file: CodexHooksFile): CodexHooksEdit {
  if (codexHookPositions(file).length === 0) return { kind: 'unchanged' };
  const next = withStop(file, withoutOurs(stopGroups(file)));
  return { kind: 'written', file: Object.keys(next).length === 0 ? null : next, replacedOlder: false };
}

/** Codex's key for one hook's state in config.toml (`codex-rs/hooks/src/lib.rs` `hook_key`). */
export function codexHookKey(hooksPath: string, position: Pick<CodexHookPosition, 'group' | 'handler'>): string {
  return `${hooksPath}:${CODEX_HOOK_EVENT_KEY}:${position.group}:${position.handler}`;
}

/** The lines of the config.toml table `[hooks.state."<key>"]`, or null when there is none. */
function stateTable(toml: string, key: string): string[] | null {
  const headers = new Set([`[hooks.state.${JSON.stringify(key)}]`, `[hooks.state.'${key}']`]);
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((line) => headers.has(line.trim()));
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body;
}

/**
 * Whether Codex will run the hook at `key`: Codex runs a user hook only after someone approved it (`/hooks` in the
 * CLI, Settings › Hooks in the app), which records `trusted_hash` under `[hooks.state."<key>"]` in config.toml; a
 * hook turned off there has `enabled = false`. The hash itself is not checked here, so a hook changed after its
 * approval still reads as approved.
 */
export function codexHookApproval(toml: string, key: string): 'approved' | 'pending' | 'disabled' {
  const body = stateTable(toml, key);
  if (body === null) return 'pending';
  if (body.some((line) => /^\s*enabled\s*=\s*false\b/.test(line))) return 'disabled';
  return body.some((line) => /^\s*trusted_hash\s*=\s*["']sha256:/.test(line)) ? 'approved' : 'pending';
}

const APPROVAL_LINE = /^\s*(?:trusted_hash|trusted_content_hash|enabled)\s*=/;
const isBlank = (line: string): boolean => line.trim() === '';
const isHeader = (line: string): boolean => /^\s*\[/.test(line);

/** Removes lines `start` up to `end` and the blank line Codex puts before a table, if there is one. */
function cut(lines: string[], start: number, end: number): string[] {
  const from = start > 0 && isBlank(lines[start - 1]!) ? start - 1 : start;
  return [...lines.slice(0, from), ...lines.slice(end)];
}

/**
 * Removes the approvals Codex recorded for our hook (`[hooks.state."<key>"]`), so a removal leaves config.toml as it
 * was before. Only a table that holds nothing but approval fields goes; then an empty `[hooks.state]` header Codex
 * wrote above it. Returns the text unchanged when there is nothing of ours.
 */
export function removeCodexHookApprovals(toml: string, keys: readonly string[]): string {
  let lines = toml.split('\n');
  for (const key of keys) {
    const headers = new Set([`[hooks.state.${JSON.stringify(key)}]`, `[hooks.state.'${key}']`]);
    const start = lines.findIndex((line) => headers.has(line.trim()));
    if (start === -1) continue;
    let end = start + 1;
    while (end < lines.length && !isHeader(lines[end]!)) end += 1;
    while (end > start + 1 && isBlank(lines[end - 1]!)) end -= 1;
    if (!lines.slice(start + 1, end).every((line) => isBlank(line) || APPROVAL_LINE.test(line))) continue;
    lines = cut(lines, start, end);
  }
  const bare = lines.findIndex((line) => line.trim() === '[hooks.state]');
  if (bare !== -1 && lines.every((line) => !line.trim().startsWith('[hooks.state.'))) {
    let end = bare + 1;
    while (end < lines.length && !isHeader(lines[end]!)) end += 1;
    if (lines.slice(bare + 1, end).every(isBlank)) {
      // At the end of the file the blank line before it goes and the final newline stays; elsewhere only the
      // header and the blank lines after it go.
      lines = end === lines.length ? cut(lines, bare, lines.length - 1) : [...lines.slice(0, bare), ...lines.slice(end)];
    }
  }
  return lines.join('\n');
}

const FEATURE_OFF = /^\s*(?:codex_)?hooks\s*=\s*(?:false\b|\{[^}]*\benabled\s*=\s*false\b)/;
const DOTTED_FEATURE_OFF = /^\s*features\.(?:codex_)?hooks\s*=\s*(?:false\b|\{[^}]*\benabled\s*=\s*false\b)/;
const INLINE_FEATURES_OFF = /^\s*features\s*=\s*\{[^}]*\b(?:codex_)?hooks\s*=\s*false\b/;

/** True when the TOML turns the hooks feature off: `[features] hooks = false` (or the older `codex_hooks`). */
export function hooksFeatureOff(toml: string): boolean {
  let table = '';
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (header) {
      table = header[1]!;
      continue;
    }
    if (table === 'features' && FEATURE_OFF.test(line)) return true;
    if (table === '' && (DOTTED_FEATURE_OFF.test(line) || INLINE_FEATURES_OFF.test(line))) return true;
  }
  return false;
}

/**
 * Why Codex would ignore a hook we add to the user's hooks.json, from its config.toml and (on macOS and Linux)
 * `/etc/codex/requirements.toml`, or null when nothing turns hooks off.
 */
export function codexHooksOffReason(configToml: string, requirementsToml: string | null): string | null {
  if (hooksFeatureOff(configToml)) return 'hooks are turned off in its config.toml ([features] hooks = false)';
  if (requirementsToml !== null) {
    if (hooksFeatureOff(requirementsToml)) return 'hooks are turned off by your administrator (requirements.toml)';
    if (/^\s*allow_managed_hooks_only\s*=\s*true\b/m.test(requirementsToml)) {
      return 'only administrator hooks may run (allow_managed_hooks_only in requirements.toml)';
    }
  }
  return null;
}

/** Codex 0.129.0 started running a user hook only once it is trusted; 0.131.0 added the "Hooks need review" prompt. */
const TRUST_SINCE = '0.129.0';
const PROMPT_SINCE = '0.131.0';

/** How to get Codex to run the hook, for someone who has never heard of Codex hooks. `version` null: assume a current Codex. */
export function codexTrustSteps(version: string | null): string[] {
  const restart = '1. Quit Codex and open it again. It reads hooks when it starts.';
  const where = `The hook is listed as "${CODEX_HOOK_NAME}".`;
  const viaHooks = 'Type /hooks in Codex, select Stop, press Enter, then t (trust), then Esc twice.';
  if (version !== null && !atLeast(version, TRUST_SINCE)) {
    return ['Codex starts running the hook the next time it starts:', `  ${restart}`, '  This Codex runs hooks without asking you to trust them first.'];
  }
  if (version !== null && !atLeast(version, PROMPT_SINCE)) {
    return ['Codex runs a new hook only after you trust it:', `  ${restart}`, `  2. ${viaHooks}`, `  ${where}`];
  }
  return [
    'Codex runs a new hook only after you trust it:',
    `  ${restart}`,
    '  2. When it asks "Hooks need review", press 2 ("Trust all and continue"), then Enter.',
    '     Enter alone does not trust it.',
    `  Missed it? ${viaHooks}`,
    `  ${where}`,
    '  In the Codex app: Settings › Hooks.',
  ];
}

/** How to turn the hook back on after someone switched it off in Codex's /hooks. */
export const CODEX_TURN_ON_STEPS = 'Type /hooks in Codex, select Stop, press Enter, then Space (turn it on), then Esc twice.';

/** `codex-cli 0.155.1` → `0.155.1`; null when there is no x.y.z in it. */
export function parseCodexVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

function atLeast(version: string, minimum: string): boolean {
  const parts = (text: string) => text.split('.').map(Number);
  const have = parts(version);
  const need = parts(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

/** True when `version` (x.y.z) is at least `CODEX_HOOKS_MIN_VERSION`. */
export function codexSupportsHooks(version: string): boolean {
  return atLeast(version, CODEX_HOOKS_MIN_VERSION);
}
