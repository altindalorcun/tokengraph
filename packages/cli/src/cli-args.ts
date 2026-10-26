// Argument checks and messages shared by bin.ts, kept out of it so they can be tested (bin.ts runs on import).

/** Claude Code hook events that fire when a turn or a session ends, so a sync there sees the new usage. */
export const CLAUDE_SYNC_EVENTS = ['SessionEnd', 'Stop', 'SubagentStop'] as const;

/** `--since <days>`: a plain whole number from 1 to 400, or null. `1.5`, `1e2` and `7abc` are rejected. */
export function parseSinceDays(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= 400 ? days : null;
}

/**
 * Null when `event` may be used, else the error. Installing takes only the events in CLAUDE_SYNC_EVENTS; removing
 * takes any name, so a hook put on another event by hand or by an older version can still be taken off.
 */
export function checkHookEvent(event: string, remove: boolean): string | null {
  if (remove || (CLAUDE_SYNC_EVENTS as readonly string[]).includes(event)) return null;
  return `--event must be ${CLAUDE_SYNC_EVENTS.slice(0, -1).join(', ')} or ${CLAUDE_SYNC_EVENTS.at(-1)}, not ${event}.`;
}

/**
 * Rewrites a node:util parseArgs error for people: a missing value names the placeholder the command's help uses
 * (`--since <days>`), and the advice about `--` Node appends to unknown-option errors is dropped.
 */
export function friendlyParseError(message: string, help: string | undefined): string {
  const missing = /^Option '(?:-\w, )?--([\w-]+) <value>' argument missing/.exec(message);
  if (missing) {
    const flag = missing[1]!;
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const placeholder = help ? new RegExp(`--${escaped} (<[^>]+>)`).exec(help)?.[1] : undefined;
    return `--${flag} needs a value: --${flag} ${placeholder ?? '<value>'}`;
  }
  return message.replace(/\. To specify a positional argument[\s\S]*$/, '.');
}
