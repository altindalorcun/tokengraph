import { describe, expect, it } from 'vitest';
import { isTokenGraphHookCommand } from '../src/hook-settings.js';
import {
  CRON_MARKER,
  cronLine,
  launchdPlist,
  schtasksCreateArgs,
  scheduledArgs,
  SCHEDULE_LABEL,
  withCronEntry,
  withoutCronEntry,
} from '../src/schedule-entries.js';

const args = scheduledArgs('/usr/bin/node', '/x/token-graph/dist/bin.js');
const log = '/home/me/.token-graph/schedule.log';

describe('scheduledArgs', () => {
  it('runs a 30-day sync tagged as scheduled', () => {
    expect(args).toEqual(['/usr/bin/node', '/x/token-graph/dist/bin.js', 'sync', '--since', '30', '--trigger', 'schedule']);
  });

  it('joins into a command that isTokenGraphHookCommand recognises', () => {
    const [node, bin, ...rest] = args;
    expect(isTokenGraphHookCommand(`"${node}" "${bin}" ${rest.join(' ')}`)).toBe(true);
  });
});

describe('launchdPlist', () => {
  const plist = launchdPlist(args, log);

  it('runs hourly, first sync at load, and logs to the schedule log', () => {
    expect(plist).toContain(`<string>${SCHEDULE_LABEL}</string>`);
    expect(plist).toContain('<key>StartInterval</key>\n  <integer>3600</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${log}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${log}</string>`);
  });

  it('lists every argument as its own string', () => {
    for (const arg of args) expect(plist).toContain(`<string>${arg}</string>`);
  });

  it('escapes XML special characters in paths', () => {
    const tricky = launchdPlist(['/a & b/node', '/x/<token-graph>/bin.js'], '/l"og&.txt');
    expect(tricky).toContain('<string>/a &amp; b/node</string>');
    expect(tricky).toContain('<string>/x/&lt;token-graph&gt;/bin.js</string>');
    expect(tricky).toContain('<string>/l&quot;og&amp;.txt</string>');
    expect(tricky).not.toContain('a & b');
  });
});

describe('cronLine', () => {
  it('quotes the first two args and redirects to the log', () => {
    expect(cronLine(args, log, 17)).toBe(
      `17 * * * * "/usr/bin/node" "/x/token-graph/dist/bin.js" sync --since 30 --trigger schedule >> "${log}" 2>&1 ${CRON_MARKER}`,
    );
  });

  it('escapes % because cron treats it as a newline', () => {
    expect(cronLine(['/n%d/node', '/x/token-graph/dist/bin.js'], '/l%g', 17)).toContain('"/n\\%d/node"');
  });
});

describe('withCronEntry', () => {
  const line = cronLine(args, log, 17);

  it('appends to an empty crontab', () => {
    expect(withCronEntry('', line)).toBe(`${line}\n`);
  });

  it('keeps other lines and replaces an older marker line', () => {
    const existing = `0 5 * * * backup\n17 * * * * old-command ${CRON_MARKER}\n30 6 * * * other\n`;
    expect(withCronEntry(existing, line)).toBe(`0 5 * * * backup\n30 6 * * * other\n${line}\n`);
  });

  it('adds a missing trailing newline before appending', () => {
    expect(withCronEntry('0 5 * * * backup', line)).toBe(`0 5 * * * backup\n${line}\n`);
  });

  it('keeps interior blank lines and comments that mention the marker mid-line', () => {
    const existing = `# note: ${CRON_MARKER} runs below\n\n0 5 * * * backup\n\n\n17 * * * * old ${CRON_MARKER}\n30 6 * * * other\n\n`;
    expect(withCronEntry(existing, line)).toBe(
      `# note: ${CRON_MARKER} runs below\n\n0 5 * * * backup\n\n\n30 6 * * * other\n${line}\n`,
    );
  });
});

describe('withoutCronEntry', () => {
  it('drops only the marker line', () => {
    const existing = `0 5 * * * backup\n${cronLine(args, log, 17)}\n30 6 * * * other\n`;
    expect(withoutCronEntry(existing)).toBe('0 5 * * * backup\n30 6 * * * other\n');
  });

  it('leaves an unrelated crontab unchanged', () => {
    expect(withoutCronEntry('0 5 * * * backup\n')).toBe('0 5 * * * backup\n');
  });

  it('keeps interior blank lines and only drops lines that end with the marker', () => {
    const existing = `# ${CRON_MARKER} is ours\n\n0 5 * * * backup\n\n${cronLine(args, log, 17)}  \n\n30 6 * * * other\n\n\n`;
    expect(withoutCronEntry(existing)).toBe(`# ${CRON_MARKER} is ours\n\n0 5 * * * backup\n\n\n30 6 * * * other\n`);
  });

  it('returns an empty string when our line was the only one', () => {
    expect(withoutCronEntry(`${cronLine(args, log, 17)}\n`)).toBe('');
  });
});

describe('schtasksCreateArgs', () => {
  it('creates an hourly task with the quoted command', () => {
    expect(schtasksCreateArgs(args)).toEqual([
      '/Create',
      '/F',
      '/SC',
      'HOURLY',
      '/TN',
      'tokengraph-sync',
      '/TR',
      '"/usr/bin/node" "/x/token-graph/dist/bin.js" sync --since 30 --trigger schedule',
    ]);
  });
});
