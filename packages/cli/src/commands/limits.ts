import { stat } from 'node:fs/promises';
import {
  CLAUDE_CODE_SOURCE,
  CODEX_CLI_SOURCE,
  dateKey,
  limitViews,
  type LimitCredits,
  type LimitOrigin,
  type LimitReading,
  type LimitView,
} from '@tokengraph/core';
import { readSettings, settingsPath } from './install-hook.js';
import { setClaudeLimits, statuslineInstalled } from '../claude-statusline.js';
import { readLedger, type Ledger } from '../ledger.js';
import { readCodexLimits } from '../limits/codex.js';
import { readLimitsFile } from '../limits/store.js';
import { ledgerPath } from '../paths.js';
import { buildViewModel } from '../tui/model.js';

/**
 * `tokengraph limits`: the plan limit readings of Claude Code and Codex, as the agents reported them, and the
 * `--json` contract menu bars and the notch app read. Reads no agent logs beyond the newest Codex rollouts: today's
 * totals come from the ledger the hooks keep up to date.
 */

export interface LimitsDeps {
  now: () => Date;
  today: () => string;
  claude: () => Promise<LimitReading | null>;
  codex: () => Promise<LimitReading[]>;
  ledger: () => Promise<Ledger>;
  /** When the ledger file was last written, or null when there is none. */
  ledgerUpdatedAt: () => Promise<string | null>;
  /** Whether Claude Code's status line goes through tokengraph; null when its settings cannot be read. */
  wrapperOn: () => Promise<boolean | null>;
}

export async function claudeWrapperOn(): Promise<boolean | null> {
  try {
    return statuslineInstalled(await readSettings(settingsPath()));
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: LimitsDeps = {
  now: () => new Date(),
  today: () => dateKey(new Date()),
  claude: async () => (await readLimitsFile()).claudeCode,
  codex: () => readCodexLimits().catch(() => []),
  ledger: () => readLedger(ledgerPath()),
  ledgerUpdatedAt: async () => {
    const info = await stat(ledgerPath()).catch(() => null);
    return info ? info.mtime.toISOString() : null;
  },
  wrapperOn: claudeWrapperOn,
};

export interface LimitJsonEntry {
  source: string;
  limitId: string | null;
  plan: string | null;
  origin: LimitOrigin;
  readAt: string;
  credits: LimitCredits | null;
  windows: { id: string; label: string; minutes: number | null; usedPercent: number | null; resetsAt: string; reset: boolean }[];
}

export interface LimitsJson {
  schema: 1;
  generatedAt: string;
  today: { date: string; weightedTokens: number; costUsd: number; ledgerUpdatedAt: string | null };
  limits: LimitJsonEntry[];
}

/** The agent key shown to people and in the JSON: `codex`, not the ledger's `codex-cli`. */
export function limitAgentKey(source: string): string {
  return source === CODEX_CLI_SOURCE ? 'codex' : source;
}

export function limitJsonEntries(views: readonly LimitView[]): LimitJsonEntry[] {
  return views.map((view) => ({
    source: limitAgentKey(view.source),
    limitId: view.limitId,
    plan: view.plan,
    origin: view.origin,
    readAt: view.readAt,
    credits: view.credits,
    windows: view.windows.map(({ id, label, minutes, usedPercent, resetsAt, reset }) => ({ id, label, minutes, usedPercent, resetsAt, reset })),
  }));
}

/** Every reading, as every surface shows it, and whether Claude Code's status line is wrapped. */
export async function readLimits(overrides: Partial<LimitsDeps> = {}): Promise<{ views: LimitView[]; wrapperOn: boolean | null }> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const [claude, codex, wrapperOn] = await Promise.all([deps.claude(), deps.codex(), deps.wrapperOn()]);
  return { views: limitViews([...(claude ? [claude] : []), ...codex], deps.now()), wrapperOn };
}

export async function buildLimitsJson(overrides: Partial<LimitsDeps> = {}): Promise<LimitsJson> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const now = deps.now();
  const today = deps.today();
  const [{ views }, ledger, ledgerUpdatedAt] = await Promise.all([readLimits(deps), deps.ledger(), deps.ledgerUpdatedAt()]);
  const day = buildViewModel(ledger, today).byDate.get(today);
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    // Unpriced models are left out of the cost, as everywhere.
    today: { date: today, weightedTokens: day?.weighted ?? 0, costUsd: Math.round((day?.cost.dollars ?? 0) * 100) / 100, ledgerUpdatedAt },
    limits: limitJsonEntries(views),
  };
}

const MINUTE = 60_000;
const UNITS: readonly [string, number][] = [
  ['d', 1440 * MINUTE],
  ['h', 60 * MINUTE],
  ['m', MINUTE],
];

/** The two largest units: `4d 2h`, `1h 12m`, `3m`, `<1m`. */
export function durationText(ms: number): string {
  if (ms < MINUTE) return '<1m';
  const parts: string[] = [];
  let rest = ms;
  for (const [unit, size] of UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (parts.length > 0 || count > 0) parts.push(count > 0 ? `${count}${unit}` : '');
    if (parts.length === 2) break;
  }
  return parts.filter(Boolean).join(' ');
}

export function ageText(ms: number): string {
  return ms < MINUTE ? 'just now' : `${durationText(ms)} ago`;
}

/** `Claude Code`, `Codex · free`, with a limit id other than Codex's main one. */
export function limitName(view: Pick<LimitView, 'source' | 'plan' | 'limitId'>): string {
  const base = view.source === CLAUDE_CODE_SOURCE ? 'Claude Code' : view.source === CODEX_CLI_SOURCE ? 'Codex' : view.source;
  return [base, view.plan, view.limitId && view.limitId !== 'codex' ? view.limitId : null].filter(Boolean).join(' · ');
}

export function noClaudeReadingText(wrapperOn: boolean | null, howTo: string): string {
  return wrapperOn === true ? 'no reading yet' : `no reading · ${howTo}`;
}

/** The readings as plain text lines, shared by `tokengraph limits` and `status`. */
export function limitRows(views: readonly LimitView[], wrapperOn: boolean | null): string[] {
  const hasClaude = views.some((view) => view.source === CLAUDE_CODE_SOURCE);
  const names = [...(hasClaude ? [] : ['Claude Code']), ...views.map(limitName)];
  const nameWidth = Math.max(...names.map((name) => name.length)) + 2;
  const windows = views.flatMap((view) => view.windows);
  const labelWidth = Math.max(0, ...windows.map((w) => w.label.length));
  const pctWidth = Math.max(0, ...windows.filter((w) => !w.reset).map((w) => `${Math.round(w.usedPercent!)}%`.length));

  const rows: { body: string; age: string | null }[] = [];
  if (!hasClaude) rows.push({ body: `${'Claude Code'.padEnd(nameWidth)}${noClaudeReadingText(wrapperOn, 'run tokengraph limits on')}`, age: null });
  const extras = new Map<number, string>();
  for (const view of views) {
    view.windows.forEach((window, index) => {
      const name = (index === 0 ? limitName(view) : '').padEnd(nameWidth);
      const middle = window.reset
        ? 'reset · no reading since'
        : `${`${Math.round(window.usedPercent!)}%`.padStart(pctWidth)}  resets in ${durationText(window.resetsInMs)}`;
      rows.push({ body: `${name}${window.label.padEnd(labelWidth)}  ${middle}`, age: index === 0 ? ageText(view.ageMs) : null });
    });
    if (view.credits) extras.set(rows.length - 1, `${''.padEnd(nameWidth)}credits ${view.credits.unlimited ? 'unlimited' : (view.credits.balance ?? '')}`.trimEnd());
  }
  const bodyWidth = Math.max(0, ...rows.filter((row) => row.age !== null).map((row) => row.body.length));
  const lines: string[] = [];
  rows.forEach((row, index) => {
    lines.push(row.age === null ? row.body.trimEnd() : `${row.body.padEnd(bodyWidth)}  · ${row.age}`);
    const extra = extras.get(index);
    if (extra) lines.push(extra);
  });
  return lines;
}

export const LIMITS_HELP = `Usage: tokengraph limits [on|off] [--json]

Shows how much of each Claude Code and Codex plan limit is used, as the agents report it.
Codex readings come from its session logs. Claude Code readings need its status line:
\`tokengraph limits on\` wraps your status line (your own command keeps running), \`off\` puts it back.

Options:
  --json    Print the readings and today's totals as JSON (schema 1). Reads no agent logs.
`;

export async function runLimits(positionals: string[], options: { json: boolean }, deps: Partial<LimitsDeps> = {}): Promise<number> {
  const [action, ...extra] = positionals;
  if (extra.length > 0 || (action !== undefined && action !== 'on' && action !== 'off')) {
    console.error(LIMITS_HELP);
    return 1;
  }
  if (action !== undefined) {
    const { message, code } = await setClaudeLimits(action === 'on');
    (code === 0 ? console.log : console.error)(message);
    return code;
  }
  if (options.json) {
    console.log(JSON.stringify(await buildLimitsJson(deps), null, 2));
    return 0;
  }
  const { views, wrapperOn } = await readLimits(deps);
  for (const line of limitRows(views, wrapperOn)) console.log(line);
  return 0;
}
