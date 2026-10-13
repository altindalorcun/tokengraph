/** launchd label, and the base of the Windows task name. */
export const SCHEDULE_LABEL = 'dev.tokengraph.sync';
/** Trailing comment that marks our crontab line so it can be replaced or removed later. */
export const CRON_MARKER = '# tokengraph-sync';
/** The marker pre-release builds (named `token-graph`) wrote; still recognised so their line is replaced, not duplicated. */
const LEGACY_CRON_MARKER = '# token-graph-sync';
const WINDOWS_TASK_NAME = 'tokengraph-sync';

/** The argv of one scheduled run. Paths contain no shell syntax; the sync is tagged with its trigger. */
export function scheduledArgs(node: string, bin: string): string[] {
  return [node, bin, 'sync', '--since', '30', '--trigger', 'schedule'];
}

/** First two args (node and script paths) quoted, the rest space-joined: the shape `isTokenGraphHookCommand` expects. */
function commandText(args: readonly string[]): string {
  const [node, bin, ...rest] = args;
  return [`"${node}"`, `"${bin}"`, ...rest].join(' ');
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function launchdPlist(args: readonly string[], logPath: string): string {
  const strings = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SCHEDULE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** cron treats an unescaped % as a newline. */
function cronEscape(text: string): string {
  return text.replaceAll('%', '\\%');
}

/**
 * `minute` is picked at random when the schedule is installed: one fixed minute would have every
 * Linux machine sync in the same minute of every hour. launchd (`StartInterval`) and Task
 * Scheduler (`/SC HOURLY` from the time of creation) already spread on their own.
 */
export function cronLine(args: readonly string[], logPath: string, minute: number): string {
  return `${minute} * * * * ${cronEscape(commandText(args))} >> "${cronEscape(logPath)}" 2>&1 ${CRON_MARKER}`;
}

function isMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.endsWith(CRON_MARKER) || trimmed.endsWith(LEGACY_CRON_MARKER);
}

/** Whether the crontab holds our line: one that ends with the marker, not one that merely mentions it. */
export function hasCronEntry(existing: string): boolean {
  return existing.split('\n').some(isMarkerLine);
}

/** The crontab without our line. Interior blank lines stay; only blank lines at the very end go. */
function withoutMarkerLines(existing: string): string[] {
  const kept = existing.split('\n').filter((line) => !isMarkerLine(line));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  return kept;
}

export function withCronEntry(existing: string, line: string): string {
  return `${[...withoutMarkerLines(existing), line].join('\n')}\n`;
}

export function withoutCronEntry(existing: string): string {
  const kept = withoutMarkerLines(existing);
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

export function schtasksCreateArgs(args: readonly string[]): string[] {
  return ['/Create', '/F', '/SC', 'HOURLY', '/TN', WINDOWS_TASK_NAME, '/TR', commandText(args)];
}

export function schtasksDeleteArgs(): string[] {
  return ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME];
}
