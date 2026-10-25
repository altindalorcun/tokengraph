import { agentName } from '@tokengraph/core';
import type { ActionId } from '../actions.js';
import type { AutoSyncStatus } from '../auto-sync.js';
import { mix } from '../color.js';
import { RANGE_LABELS, agentBreakdown, agentBuckets, rangeBuckets } from '../model.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import type { TuiTheme } from '../theme.js';
import type { TableState, ViewProps, ViewResult } from './props.js';
import { drawColumnChart } from './chart.js';
import { drawBreakdownTable, type FooterPart } from './table.js';

// Agent i (by all-time rank) is the accent faded towards the background: colour means model family, so no agent gets a family hue.
// The accent is the brand red, so the top agent is faded a little to stay distinct from the error red.
const AGENT_FADE = [0.12, 0.35, 0.55, 0.7, 0.8, 0.88];

/** `name ✓` / `name —` / `name ?` for installed / not installed / unknown. */
function status(label: string, value: boolean | null, action: ActionId, theme: TuiTheme): FooterPart[] {
  const mark = value === null ? { text: '?', color: theme.muted } : value ? { text: '✓', color: theme.good } : { text: '—', color: theme.muted };
  return [{ text: `${label} `, color: theme.muted, action }, { ...mark, action }];
}

/** The statuses, each clickable to its Setup row, then `h manage`; the `auto-sync` lead-in goes when the line would not fit. */
function autoSyncFooter(autoSync: AutoSyncStatus, theme: TuiTheme, width: number): FooterPart[] {
  const gap = { text: '  ', color: theme.muted };
  const parts: FooterPart[] = [
    ...status('Claude Code hook', autoSync.claudeHook, 'hook:claude-code', theme),
    gap,
    ...status('Cursor hook', autoSync.cursorHook, 'hook:cursor', theme),
    gap,
    ...status('Codex notify', autoSync.codexNotify, 'hook:codex', theme),
    gap,
    ...status('Gemini hook', autoSync.geminiHook, 'hook:gemini-cli', theme),
    gap,
    ...status('hourly schedule', autoSync.schedule, 'schedule', theme),
    gap,
    { text: 'h manage', color: theme.accent },
  ];
  const lead: FooterPart = { text: 'auto-sync  ', color: theme.ink };
  const length = (list: readonly FooterPart[]) => list.reduce((sum, part) => sum + [...part.text].length, 0);
  return length([lead, ...parts]) <= width ? [lead, ...parts] : parts;
}

/** Agents ranked by weighted tokens, with last activity, a 30-day sparkline, detected-but-unused agents and the auto-sync state. */
export function drawAgents(
  buf: ScreenBuffer,
  rect: Rect,
  props: ViewProps & { state: TableState; autoSync: AutoSyncStatus | null; detected: readonly string[] },
): ViewResult {
  const { vm, theme, state, autoSync, detected } = props;
  const idle = detected.filter((source) => !vm.sources.includes(source)).map((source) => `${agentName(source)}  detected · no usage yet`);
  const rank = agentBreakdown(vm, 'all').map((a) => a.key);
  const agentColor = (source: string) => mix(theme.accent, theme.bg, AGENT_FADE[Math.min(Math.max(0, rank.indexOf(source)), AGENT_FADE.length - 1)]!);
  return drawBreakdownTable(buf, rect, props, {
    label: 'AGENT',
    rows: agentBreakdown(vm, state.range),
    color: (row) => agentColor(row.key),
    extras: true,
    idle,
    footer: autoSync ? autoSyncFooter(autoSync, theme, rect.width) : undefined,
    chart: (view, area) => {
      const buckets = agentBuckets(vm, rangeBuckets(vm, state.range));
      const present = new Set(buckets.flatMap((b) => b.agents.map((a) => a.source)));
      drawColumnChart(view, area, theme, {
        title: `TOKENS BY AGENT · ${RANGE_LABELS[state.range].toUpperCase()}`,
        columns: buckets.map((b) => ({
          label: b.bucket.label,
          segments: b.agents.map((a) => ({ value: a.weighted, color: agentColor(a.source), key: a.source })),
        })),
        legend: rank.filter((source) => present.has(source)).map((source) => ({ text: agentName(source), color: agentColor(source), key: source })),
      });
    },
  });
}
