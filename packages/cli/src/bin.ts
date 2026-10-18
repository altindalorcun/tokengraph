#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { cliVersion } from './bin-path.js';
import { runCursorHook } from './commands/cursor-hook.js';
import { parseExportArgs, runExport } from './commands/export.js';
import { runHookSync } from './commands/hook-sync.js';
import { parseImportArgs, runImportCursor } from './commands/import.js';
import { DEFAULT_HOOK_EVENT, resolveHookAgent, runInstallHook } from './commands/install-hook.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runReadme } from './commands/readme.js';
import { runSchedule } from './commands/schedule.js';
import { runStatus } from './commands/status.js';
import { parseStoryArgs, runStory } from './commands/story.js';
import { runSync } from './commands/sync.js';
import { runUninstall } from './commands/uninstall.js';
import { runView } from './commands/view.js';
import { removeHostedLeftovers } from './hosted-leftovers.js';
import { migrateLegacyHome } from './paths.js';

const USAGE = `tokengraph — track how many tokens your AI coding agents burn each day

Usage: tokengraph [command] [options]

Commands:
  view                 Explore your usage in the terminal (the default in a terminal)
  sync                 Read local agent data; publish your graph when logged in
  login                Connect GitHub to publish your graph to your own gist
  readme               Print the README snippet for your graph (and copy it)
  logout               Disconnect GitHub on this machine
  status               Show the account, ledger and background syncs on this machine
  install-hook         Sync automatically when Claude Code, Cursor or Codex finishes
  schedule             Sync every hour in the background
  story                Turn your usage into story cards and send them to your phone
  export               Write your daily usage as CSV or JSON
  import               Add history from another source, such as a Cursor usage CSV
  uninstall            Remove the hooks and the schedule (and, with --purge, your data)

Run \`tokengraph <command> --help\` for a command's options.

  -h, --help           Show this help
  -v, --version        Show the version

Everything works without logging in: usage stays on this machine until you publish it.
`;

type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | undefined>;

interface Command {
  /** Shown by `tokengraph <command> --help`. Absent for the hidden commands hooks run. */
  help?: string;
  options: Options;
  /** Hidden commands are run by other programs and must never fail on an argument they did not expect. */
  lenient?: boolean;
  run: (values: Values, positionals: string[]) => Promise<number> | number;
}

const HELP_FLAG: Options = { help: { type: 'boolean', short: 'h', default: false } };

const VIEW_OPTIONS: Options = {
  print: { type: 'boolean', default: false },
  'no-motion': { type: 'boolean', default: false },
  'no-live': { type: 'boolean', default: false },
  theme: { type: 'string', default: 'auto' },
};

const VIEW_HELP = `Usage: tokengraph view [options]

Opens an interactive view of your usage. Reads local data only; it never publishes.

Options:
  --print              Print a static snapshot and exit (the default when not in a terminal)
  --no-motion          Skip animations
  --no-live            Don't rescan while open
  --theme <name>       auto, dark or light (default: auto)
`;

function launchView(values: Values): Promise<number> | number {
  const theme = values['theme'];
  if (theme !== 'auto' && theme !== 'dark' && theme !== 'light') {
    console.error('--theme must be auto, dark or light.');
    return 1;
  }
  return runView({ motion: !values['no-motion'], live: !values['no-live'], print: values['print'] === true, theme });
}

function hookSyncOptions(raw: string | boolean | undefined): { minIntervalSeconds?: number } {
  const seconds = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(seconds) && seconds > 0 ? { minIntervalSeconds: seconds } : {};
}

const COMMANDS: Record<string, Command> = {
  view: { help: VIEW_HELP, options: VIEW_OPTIONS, run: launchView },

  sync: {
    help: `Usage: tokengraph sync [options]

Reads every supported agent's local data into the ledger (~/.tokengraph/state.json), then, when you
are logged in, publishes your graph to your gist. \`--local\` never touches the network. Background
syncs (hooks, schedule) do the same.

Options:
  --since <days>       How far back to read, 1-400 (default: 90)
  --local              Update the local ledger only, never touch the network
`,
    options: {
      since: { type: 'string', default: '90' },
      local: { type: 'boolean', default: false },
      // Undocumented: writes a preview of the embeddable graph, for working on the renderer.
      svg: { type: 'string' },
      theme: { type: 'string', default: 'light' },
      // Internal: which kind of caller started the sync (hook-sync and schedule pass it).
      trigger: { type: 'string', default: 'manual' },
    },
    run: (values) => {
      const sinceDays = Number.parseInt(String(values['since']), 10);
      if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 400) {
        console.error('--since must be a whole number of days between 1 and 400.');
        return 1;
      }
      const theme = values['theme'];
      if (theme !== 'light' && theme !== 'dark') {
        console.error('--theme must be light or dark.');
        return 1;
      }
      const trigger = values['trigger'];
      if (trigger !== 'manual' && trigger !== 'hook' && trigger !== 'schedule') {
        console.error('--trigger must be manual, hook or schedule.');
        return 1;
      }
      return runSync({
        sinceDays,
        local: values['local'] === true,
        svgPath: typeof values['svg'] === 'string' ? values['svg'] : undefined,
        theme,
        trigger,
      });
    },
  },

  readme: {
    help: `Usage: tokengraph readme [options]

Prints the snippet that shows your graph in a GitHub README and copies it to the clipboard. The
graph switches between light and dark with the reader's theme.

Options:
  --compact            A smaller graph without labels and legends
  --colors <mode>      model (each day takes its model family's colour) or single; republishes
`,
    options: { compact: { type: 'boolean', default: false }, colors: { type: 'string' } },
    run: (values) => {
      const colors = values['colors'];
      if (colors !== undefined && colors !== 'model' && colors !== 'single') {
        console.error('--colors must be model or single.');
        return 1;
      }
      return runReadme({ compact: values['compact'] === true, colors });
    },
  },

  login: {
    help: `Usage: tokengraph login [options]

Connects GitHub so sync can publish your graph to your own gist. Uses your GitHub CLI login when
you have one (asks first), otherwise a one-time code you approve in the browser. Asks for gist
access only.

Options:
  --gh                 Use the GitHub CLI login without asking
  --device             Always use a one-time code, even when the GitHub CLI is logged in
  --no-open            Do not open the browser automatically
`,
    options: {
      gh: { type: 'boolean', default: false },
      device: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
    },
    run: (values) => {
      if (values['gh'] && values['device']) {
        console.error('Choose one of --gh and --device.');
        return 1;
      }
      return runLogin({ method: values['gh'] ? 'gh' : values['device'] ? 'device' : 'auto', openBrowser: !values['no-open'] });
    },
  },

  logout: {
    help: `Usage: tokengraph logout

Forgets the GitHub login and gist ids on this machine. Local data and the machine id are kept,
and your gists stay on GitHub.
`,
    options: {},
    run: () => runLogout(),
  },

  status: {
    help: `Usage: tokengraph status [options]

Shows the account, the local ledger and which background syncs are installed on this machine.

  --json               Print one JSON object instead of text, for scripts and AI agents
`,
    options: { json: { type: 'boolean', default: false } },
    run: (values) => runStatus({}, { json: values['json'] === true }),
  },

  export: {
    help: `Usage: tokengraph export [options]

Writes your daily usage, one row per day, agent, model and pricing tier, from the local ledger.
It reads the ledger only; run \`tokengraph sync --local\` first for the newest numbers. Never publishes.

Options:
  --format <csv|json>  Output format (default: csv)
  --out <file>         Write to a file instead of standard output
  --since <date>       Only days on or after this date (YYYY-MM-DD)
  --all-machines       Add your other machines, as of the last publish
`,
    options: {
      format: { type: 'string', default: 'csv' },
      out: { type: 'string' },
      since: { type: 'string' },
      'all-machines': { type: 'boolean', default: false },
    },
    run: (values) => {
      const options = parseExportArgs(values);
      if (typeof options === 'string') {
        console.error(options);
        return 1;
      }
      return runExport(options);
    },
  },

  'install-hook': {
    help: `Usage: tokengraph install-hook --agent <name> [options]

Makes an agent start a background sync when it finishes, so your graph stays current.

Options:
  --agent <name>       claude-code, cursor or codex (required)
  --remove             Uninstall the hook
  --dry-run            Show the resulting settings without writing them
  --event <name>       Claude Code hook event (default: ${DEFAULT_HOOK_EVENT})
`,
    options: {
      agent: { type: 'string' },
      // No default: an explicit --event must be told apart from none, to reject it for cursor and codex.
      event: { type: 'string' },
      remove: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    run: (values) => {
      const resolved = resolveHookAgent(typeof values['agent'] === 'string' ? values['agent'] : undefined);
      if ('error' in resolved) {
        console.error(resolved.error);
        return 1;
      }
      const event = typeof values['event'] === 'string' ? values['event'] : undefined;
      if (resolved.agent !== 'claude-code' && event !== undefined) {
        console.error('--event only applies to --agent claude-code.');
        return 1;
      }
      return runInstallHook({
        agent: resolved.agent,
        event: event ?? DEFAULT_HOOK_EVENT,
        remove: values['remove'] === true,
        dryRun: values['dry-run'] === true,
      });
    },
  },

  schedule: {
    help: `Usage: tokengraph schedule [options]

Runs a sync every hour in the background (launchd on macOS, cron on Linux, Task Scheduler on Windows).
Use it for agents without a hook (Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code, Goose) or to pick up Cursor's recorded turns.

Options:
  --remove             Remove the hourly sync
  --dry-run            Show what would be installed without changing anything
`,
    options: {
      remove: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    run: (values) => runSchedule({ remove: values['remove'] === true, dryRun: values['dry-run'] === true }),
  },

  story: {
    help: `Usage: tokengraph story [options]

Draws your usage as Instagram / TikTok story cards, saves them as PNG files, and can send them to
your phone: scan the QR code it shows (same Wi-Fi) and save them from the page that opens.
Reads local data only.

Options:
  --template <name>    skyline, receipt, sticker or all (default: all)
  --range <range>      today, 7d, 30d or 1y (default: asks in a terminal, otherwise today)
  --no-cost            Leave the estimated API cost off the cards
  --out <dir>          Where to save (default: your Downloads folder)
  --qr                 Send to the phone without asking
  --no-qr              Only save the files
  --no-preview         Do not draw the cards in the terminal
  --handle <name>      The name on the cards (default: your GitHub login)
`,
    options: {
      template: { type: 'string' },
      range: { type: 'string' },
      'no-cost': { type: 'boolean', default: false },
      out: { type: 'string' },
      qr: { type: 'boolean', default: false },
      'no-qr': { type: 'boolean', default: false },
      'no-preview': { type: 'boolean', default: false },
      handle: { type: 'string' },
    },
    run: (values) => {
      const options = parseStoryArgs(values);
      if (typeof options === 'string') {
        console.error(options);
        return 1;
      }
      return runStory(options);
    },
  },

  import: {
    help: `Usage: tokengraph import cursor <file.csv>

Adds your Cursor history from before the hook was installed. Download the usage CSV yourself from the
Cursor dashboard (Usage, then export CSV); tokengraph reads no Cursor login and calls no Cursor API.

Importing the same or an overlapping file again adds nothing twice. Rows from the moment the Cursor hook
first ran are skipped, because the hook already counts them. The ledger is updated; nothing is published.

Import on one machine only: machines are added together, so importing the same file on two machines
counts it twice.
`,
    options: {},
    run: (_values, positionals) => {
      const args = parseImportArgs(positionals);
      if (typeof args === 'string') {
        console.error(args);
        return 1;
      }
      return runImportCursor(args.file);
    },
  },

  uninstall: {
    help: `Usage: tokengraph uninstall [options]

Removes everything tokengraph installed on this machine: the Claude Code, Cursor and Codex hooks and the
hourly schedule. Your gists and your agents' own data are never touched.

Options:
  --purge              Also delete tokengraph's own data folder (~/.tokengraph): the ledger, the login
                       and the Cursor event file
  --yes                Don't ask before deleting (needed for --purge outside a terminal)
  --dry-run            Show what would change and change nothing
`,
    options: {
      purge: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    run: (values) =>
      runUninstall({ purge: values['purge'] === true, yes: values['yes'] === true, dryRun: values['dry-run'] === true }),
  },

  // Run by Cursor's stop hook (see `install-hook --agent cursor`); not meant to be run by hand.
  'cursor-hook': { options: {}, lenient: true, run: () => runCursorHook() },

  // Run by the Claude Code and Codex hooks (see `install-hook`); not meant to be run by hand. Launches a detached
  // `sync` and returns at once, since Claude Code cancels slow hooks. Codex's notify passes one extra JSON
  // argument; it is ignored, and so is an invalid --min-interval, since a hook must never fail.
  'hook-sync': {
    options: { 'min-interval': { type: 'string' } },
    lenient: true,
    run: (values) => runHookSync({}, hookSyncOptions(values['min-interval'])),
  },
};

function parse(command: Command, args: string[]): { values: Values; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: !command.lenient,
    options: { ...HELP_FLAG, ...command.options },
  });
  return { values: values as Values, positionals };
}

async function main(argv: string[]): Promise<number> {
  migrateLegacyHome();
  await removeHostedLeftovers();

  const [first, ...rest] = argv;
  if (first === '-v' || first === '--version') {
    console.log(cliVersion());
    return 0;
  }
  if (first === '-h' || first === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (first === 'help') {
    const topic = rest[0] === undefined ? undefined : COMMANDS[rest[0]]?.help;
    console.log(topic ?? USAGE);
    return 0;
  }
  if (first === undefined && !(process.stdin.isTTY && process.stdout.isTTY)) {
    console.log(USAGE);
    return 1;
  }

  // Bare `tokengraph`, or `tokengraph --print` and friends, open the view.
  const name = first === undefined || first.startsWith('-') ? 'view' : first;
  const args = name === first ? rest : argv;
  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command: ${name}\n`);
    console.log(USAGE);
    return 1;
  }

  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parse(command, args);
  } catch (error) {
    // Node appends advice about `--` to unknown-option errors; for a command with known flags it only confuses.
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.replace(/\. To specify a positional argument[\s\S]*$/, '.'));
    console.error(`Run \`tokengraph ${name} --help\` for its options.`);
    return 1;
  }
  if (parsed.values['help'] === true && command.help) {
    console.log(command.help);
    return 0;
  }
  return command.run(parsed.values, parsed.positionals);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
