export interface HookCommand {
  type: 'command';
  command: string;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export type Settings = Record<string, unknown>;

/** Recognises a hook command as tokengraph's (or its pre-release name token-graph's), whatever form or node/bin path it was installed with. */
export type IsOurs = (command: string) => boolean;

// `"<node>" "<...tokengraph...bin.js>" hook-sync` or the older `... sync --since N [redirects]`.
// The bin path must mention tokengraph (or the pre-release token-graph) so other tools' `bin.js sync` hooks are
// never touched.
const TOKEN_GRAPH_HOOK = /^"[^"]+" "[^"]*token-?graph[^"]*bin\.js" (?:hook-sync|sync --since \d+)(?:\s[\s\S]*)?$/;

export function isTokenGraphHookCommand(command: string): boolean {
  return TOKEN_GRAPH_HOOK.test(command);
}

function readMatchers(settings: Settings, event: string): HookMatcher[] {
  const hooks = settings['hooks'];
  if (typeof hooks !== 'object' || hooks === null) return [];
  const forEvent = (hooks as Record<string, unknown>)[event];
  return Array.isArray(forEvent) ? (forEvent as HookMatcher[]) : [];
}

function commandsOf(matcher: HookMatcher): HookCommand[] {
  return Array.isArray(matcher?.hooks) ? matcher.hooks : [];
}

/** Exact-command check, used to verify an install. */
export function hasHook(settings: Settings, event: string, command: string): boolean {
  return readMatchers(settings, event).some((matcher) => commandsOf(matcher).some((hook) => hook.command === command));
}

/** Every command on `event` that `isOurs` recognises (in file order). */
export function matchingCommands(settings: Settings, event: string, isOurs: IsOurs): string[] {
  return readMatchers(settings, event)
    .flatMap(commandsOf)
    .map((hook) => hook.command)
    .filter((command): command is string => typeof command === 'string' && isOurs(command));
}

/** Events (other than `except`) that carry a hook `isOurs` recognises. */
export function eventsWithHook(settings: Settings, isOurs: IsOurs, except?: string): string[] {
  const hooks = settings['hooks'];
  if (typeof hooks !== 'object' || hooks === null) return [];
  return Object.keys(hooks).filter((event) => event !== except && matchingCommands(settings, event, isOurs).length > 0);
}

function withEvent(settings: Settings, event: string, matchers: HookMatcher[]): Settings {
  const hooks = { ...(settings['hooks'] as Record<string, unknown> | undefined) };
  if (matchers.length > 0) {
    hooks[event] = matchers;
  } else {
    delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) {
    const { hooks: _emptied, ...withoutHooks } = settings;
    return withoutHooks;
  }
  return { ...settings, hooks };
}

/** Matchers with every `isOurs` hook removed; matchers this empties are dropped, others are untouched. */
function withoutOurs(settings: Settings, event: string, isOurs: IsOurs): HookMatcher[] {
  return readMatchers(settings, event).flatMap((matcher) => {
    const hooks = commandsOf(matcher);
    const kept = hooks.filter((hook) => !(typeof hook.command === 'string' && isOurs(hook.command)));
    if (kept.length === hooks.length) return [matcher];
    return kept.length > 0 ? [{ ...matcher, hooks: kept }] : [];
  });
}

/**
 * Returns a new settings object with exactly one tokengraph hook (`command`) on `event`, replacing any
 * older-form copies. Returns `settings` itself when that is already the case. Unrelated keys and hooks are preserved.
 */
export function addHook(settings: Settings, event: string, command: string, isOurs: IsOurs): Settings {
  const existing = matchingCommands(settings, event, isOurs);
  if (existing.length === 1 && existing[0] === command) return settings;
  const matchers = [...withoutOurs(settings, event, isOurs), { hooks: [{ type: 'command' as const, command }] }];
  return withEvent(settings, event, matchers);
}

/** Removes every tokengraph hook on `event`; returns `settings` itself when there is none. */
export function removeHook(settings: Settings, event: string, isOurs: IsOurs): Settings {
  if (matchingCommands(settings, event, isOurs).length === 0) return settings;
  return withEvent(settings, event, withoutOurs(settings, event, isOurs));
}
