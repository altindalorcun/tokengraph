/**
 * Cursor's hook file (`~/.cursor/hooks.json`): `{ "version": 1, "hooks": { "<event>": [{ "command": "..." }] } }`.
 * Only tokengraph's own `stop` entries are ever added or removed; everything else is kept as-is.
 */
export type CursorHooksFile = Record<string, unknown>;

export const CURSOR_HOOK_EVENT = 'stop';

/** Recognises a hook command as tokengraph's, whatever node/bin path it was installed with. */
export type IsOurs = (command: string) => boolean;

// `"<node>" "<...tokengraph...bin.js>" cursor-hook`; the bin path must mention tokengraph (or token-graph).
const TOKEN_GRAPH_CURSOR_HOOK = /^"[^"]+" "[^"]*token-?graph[^"]*bin\.js" cursor-hook(?:\s[\s\S]*)?$/;

export function isTokenGraphCursorHookCommand(command: string): boolean {
  return TOKEN_GRAPH_CURSOR_HOOK.test(command);
}

interface HookEntry {
  command?: unknown;
}

function hooksOf(file: CursorHooksFile): Record<string, unknown> {
  const hooks = file['hooks'];
  return typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks) ? (hooks as Record<string, unknown>) : {};
}

function stopEntries(file: CursorHooksFile): HookEntry[] {
  const entries = hooksOf(file)[CURSOR_HOOK_EVENT];
  return Array.isArray(entries) ? (entries as HookEntry[]) : [];
}

function isOursEntry(entry: HookEntry, isOurs: IsOurs): boolean {
  return typeof entry?.command === 'string' && isOurs(entry.command);
}

/** Exact-command check, used to verify an install. */
export function hasCursorHook(file: CursorHooksFile, command: string): boolean {
  return stopEntries(file).some((entry) => entry?.command === command);
}

/** Every stop command `isOurs` recognises (in file order). */
export function matchingCursorCommands(file: CursorHooksFile, isOurs: IsOurs): string[] {
  return stopEntries(file)
    .filter((entry) => isOursEntry(entry, isOurs))
    .map((entry) => entry.command as string);
}

/** Leaves exactly one tokengraph stop hook (`command`), replacing older-form copies; same object when already so. */
export function addCursorHook(file: CursorHooksFile, command: string, isOurs: IsOurs): CursorHooksFile {
  const existing = matchingCursorCommands(file, isOurs);
  if (existing.length === 1 && existing[0] === command) return file;
  const others = stopEntries(file).filter((entry) => !isOursEntry(entry, isOurs));
  return {
    ...file,
    version: 1,
    hooks: { ...hooksOf(file), [CURSOR_HOOK_EVENT]: [...others, { command }] },
  };
}

export function removeCursorHook(file: CursorHooksFile, isOurs: IsOurs): CursorHooksFile {
  if (matchingCursorCommands(file, isOurs).length === 0) return file;
  const hooks = { ...hooksOf(file) };
  const remaining = stopEntries(file).filter((entry) => !isOursEntry(entry, isOurs));
  if (remaining.length > 0) hooks[CURSOR_HOOK_EVENT] = remaining;
  else delete hooks[CURSOR_HOOK_EVENT];
  return { ...file, version: 1, hooks };
}
