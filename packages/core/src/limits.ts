import { CLAUDE_CODE_SOURCE, CODEX_CLI_SOURCE, type KnownSource } from './sources.js';

/**
 * Plan limits as the agents report them (see GLOSSARY.md: usage limit, limit window, limit reading).
 * tokengraph never computes, estimates or lowers one: this module only turns stored readings and the
 * current time into what the view, `tokengraph limits` and its JSON show.
 */

/** Where a reading came from: Claude Code's status line input, a refused request in its transcript, or a Codex session log. */
export type LimitOrigin = 'statusline' | 'limit-hit' | 'session-log';

export interface LimitCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

/** The used share of one limit window, as the provider reported it. */
export interface LimitWindowReading {
  id: string;
  /** The window's length, or null when the provider does not say. */
  minutes: number | null;
  usedPercent: number;
  /** ISO instant the window resets. */
  resetsAt: string;
}

export interface LimitReading {
  source: KnownSource;
  /** Codex can report several limits (`limit_id`); null when the agent has one. */
  limitId: string | null;
  plan: string | null;
  origin: LimitOrigin;
  /** ISO instant the provider's numbers were seen. */
  readAt: string;
  credits: LimitCredits | null;
  windows: LimitWindowReading[];
}

export type LimitLevel = 'good' | 'warn' | 'bad';

export interface LimitWindowView {
  id: string;
  label: string;
  minutes: number | null;
  /** Null once the window has reset: the new share is unknown until the next reading. */
  usedPercent: number | null;
  resetsAt: string;
  reset: boolean;
  level: LimitLevel | null;
  /** Milliseconds until the reset, never below 0. */
  resetsInMs: number;
}

export interface LimitView extends Omit<LimitReading, 'windows'> {
  /** Milliseconds since the reading, never below 0. */
  ageMs: number;
  windows: LimitWindowView[];
}

/** Window lengths of the limits Claude Code reports, by the id it uses. */
export const CLAUDE_WINDOW_MINUTES: Readonly<Record<string, number>> = { five_hour: 300, seven_day: 10080 };

const MINUTES_PER_DAY = 1440;

/** `5h`, `7d`, `30d`, …; the window id when the length is unknown. */
export function limitWindowLabel(minutes: number | null, id: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return id;
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

export function limitLevel(usedPercent: number): LimitLevel {
  if (usedPercent >= 90) return 'bad';
  if (usedPercent >= 70) return 'warn';
  return 'good';
}

function sourceRank(source: string): number {
  if (source === CLAUDE_CODE_SOURCE) return 0;
  if (source === CODEX_CLI_SOURCE) return 1;
  return 2;
}

function compareReadings(a: LimitReading, b: LimitReading): number {
  return (
    sourceRank(a.source) - sourceRank(b.source) ||
    a.source.localeCompare(b.source) ||
    (a.limitId ?? '').localeCompare(b.limitId ?? '')
  );
}

function windowView(window: LimitWindowReading, now: number): LimitWindowView {
  const resetsInMs = Date.parse(window.resetsAt) - now;
  const reset = !(resetsInMs > 0);
  return {
    id: window.id,
    label: limitWindowLabel(window.minutes, window.id),
    minutes: window.minutes,
    usedPercent: reset ? null : window.usedPercent,
    resetsAt: window.resetsAt,
    reset,
    level: reset ? null : limitLevel(window.usedPercent),
    resetsInMs: reset ? 0 : resetsInMs,
  };
}

/** What every surface shows for `readings` at `now`: Claude Code first, windows shortest first. */
export function limitViews(readings: readonly LimitReading[], now: Date): LimitView[] {
  const at = now.getTime();
  return [...readings].sort(compareReadings).map((reading) => {
    const windows = [...reading.windows]
      .sort((a, b) => (a.minutes ?? Number.POSITIVE_INFINITY) - (b.minutes ?? Number.POSITIVE_INFINITY))
      .map((window) => windowView(window, at));
    const credits = reading.credits && (reading.credits.hasCredits || reading.credits.unlimited) ? reading.credits : null;
    return { ...reading, credits, ageMs: Math.max(0, at - Date.parse(reading.readAt)), windows };
  });
}
