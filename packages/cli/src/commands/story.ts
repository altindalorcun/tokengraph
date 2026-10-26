import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import {
  STORY_RANGE_LABELS,
  STORY_RANGES,
  STORY_SIZES,
  STORY_TEMPLATE_LABELS,
  STORY_TEMPLATES,
  storyFileName,
  type StoryData,
  type StoryRange,
  type StoryTemplate,
} from '@tokengraph/core';
import { downloadsDir } from '../downloads.js';
import { revealInFileManager } from '../open-url.js';
import { askChoice, askYesNo } from '../prompt.js';
import { pickLanAddress } from '../share/lan.js';
import { qrLines, qrMatrix } from '../share/qr.js';
import { startShareServer, type ShareCard } from '../share/server.js';
import { STORY_CTA } from '../story/cards/context.js';
import { loadStoryData } from '../story/input.js';
import { previewStrip } from '../story/preview.js';
import { createStoryRenderer, type StoryRenderer } from '../story/render.js';

export interface StoryCommandOptions {
  templates: StoryTemplate[];
  /** `ask`: no --range was given, so a terminal asks and anything else takes today. */
  range: StoryRange | 'ask';
  showCost: boolean;
  outDir?: string;
  qr: 'ask' | 'yes' | 'no';
  preview: boolean;
  handle?: string;
}

export interface StoryDeps {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  columns: number;
  /** Terminal height in lines, when known: the QR asks for a taller window if it would not fit. */
  rows?: number;
  platform: NodeJS.Platform;
  home: string;
  loadData: (range: StoryRange, handle?: string) => Promise<StoryData>;
  renderer: () => Promise<StoryRenderer>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  exists: (path: string) => boolean;
  /** The OS's downloads folder, which is localised on Linux and movable on Windows; null when unknown. */
  downloadsDir: (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) => string | null;
  ask: (question: string) => Promise<boolean>;
  /** The picked index, or null when the prompt was closed without an answer. */
  choose: (question: string, choices: readonly string[]) => Promise<number | null>;
  lanAddress: () => string | null;
  startShare: typeof startShareServer;
  reveal: (path: string) => void;
  out: (text: string) => void;
  /** Raw output with no newline added, for the in-place progress line in a terminal. */
  write: (text: string) => void;
  onInterrupt: (handler: () => void) => () => void;
}

export function parseStoryArgs(values: Record<string, string | boolean | undefined>): StoryCommandOptions | string {
  const template = values['template'] ?? 'all';
  const templates = template === 'all' ? [...STORY_TEMPLATES] : STORY_TEMPLATES.filter((t) => t === template);
  if (templates.length === 0) return '--template must be skyline, receipt, sticker or all.';
  const range = values['range'] ?? 'ask';
  if (range !== 'ask' && !STORY_RANGES.includes(range as StoryRange)) return '--range must be today, 7d, 30d or 1y.';
  if (values['qr'] && values['no-qr']) return 'Choose one of --qr and --no-qr.';
  const options: StoryCommandOptions = {
    templates,
    range: range as StoryRange | 'ask',
    showCost: !values['no-cost'],
    qr: values['qr'] ? 'yes' : values['no-qr'] ? 'no' : 'ask',
    preview: !values['no-preview'],
  };
  if (typeof values['out'] === 'string') options.outDir = values['out'];
  if (typeof values['handle'] === 'string') options.handle = values['handle'];
  return options;
}

/** The handle as a file-name part: anything outside [A-Za-z0-9._-] becomes "-". The card text keeps the handle as typed. */
export function safeFileHandle(handle: string): string {
  return handle.replace(/[^A-Za-z0-9._-]/g, '-') || 'me';
}

function defaultDeps(): StoryDeps {
  return {
    isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    env: process.env,
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows,
    platform: process.platform,
    home: homedir(),
    loadData: (range, handle) => loadStoryData({ range, handle }),
    renderer: () => createStoryRenderer(),
    writeFile: async (path, bytes) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    exists: existsSync,
    downloadsDir: (platform, home, env) => downloadsDir(platform, home, env),
    ask: (question) => askYesNo(question),
    choose: (question, choices) => askChoice(question, choices),
    lanAddress: () => pickLanAddress(networkInterfaces()),
    startShare: startShareServer,
    reveal: revealInFileManager,
    out: (text) => process.stdout.write(`${text}\n`),
    write: (text) => process.stdout.write(text),
    onInterrupt: (handler) => {
      process.once('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}

const CLEAR_LINE = '\r\x1b[2K';
const dim = (text: string, tty: boolean) => (tty ? `\x1b[2m${text}\x1b[22m` : text);
const bold = (text: string, tty: boolean) => (tty ? `\x1b[1m${text}\x1b[22m` : text);

const STOP_MESSAGES = {
  'all-saved': 'All cards saved. Stopped sharing.',
  idle: 'No activity for 10 minutes. Stopped sharing.',
  stopped: 'Stopped sharing.',
} as const;

/** The next longer range to suggest when one has no usage. */
const WIDER_RANGE: Record<StoryRange, StoryRange | null> = { today: '7d', '7d': '30d', '30d': '1y', '1y': null };

export async function runStory(options: StoryCommandOptions, overrides: Partial<StoryDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const tty = deps.isTTY;
  let range: StoryRange = 'today';
  if (options.range !== 'ask') range = options.range;
  else if (tty) {
    deps.out('');
    const picked = await deps.choose('  Which period should the cards cover?', STORY_RANGES.map((r) => STORY_RANGE_LABELS[r]));
    if (picked === null) return 1;
    range = STORY_RANGES[picked]!;
  }
  const data = await deps.loadData(range, options.handle);
  deps.out('');
  deps.out(`  ${bold('tokengraph story', tty)}  ${dim(`${range} · @${data.handle}`, tty)}`);
  if (data.total === 0) {
    const wider = WIDER_RANGE[range];
    deps.out(
      `  No usage in this range yet, so the cards show 0. ${wider ? `Try --range ${wider}, or run` : 'Run'} \`tokengraph sync\` to read your agents' newest logs.`,
    );
  }
  deps.out('');

  const renderer = await deps.renderer();
  const cards: ShareCard[] = [];
  const { join } = deps.platform === 'win32' ? win32 : posix;
  const findDownloads = () =>
    [deps.downloadsDir(deps.platform, deps.home, deps.env), join(deps.home, 'Downloads')].find((dir) => dir && deps.exists(dir));
  const outDir = options.outDir?.trim() || findDownloads() || deps.home;
  const fileHandle = safeFileHandle(data.handle);
  try {
    for (const template of options.templates) {
      const label = STORY_TEMPLATE_LABELS[template].name;
      if (tty) deps.write(`${CLEAR_LINE}  ${dim(`Rendering ${label}…`, tty)}`);
      const png = await renderer.render(template, { data, showCost: options.showCost, cta: STORY_CTA });
      const fileName = storyFileName(fileHandle, data.endDate, { template, range, showCost: options.showCost });
      await deps.writeFile(join(outDir, fileName), png);
      cards.push({ id: template, title: STORY_TEMPLATE_LABELS[template].name, fileName, png, ...STORY_SIZES[template] });
      deps.out(`${tty ? CLEAR_LINE : ''}  ${tty ? '✓' : '-'} ${label}`);
    }
  } catch (error) {
    if (tty) deps.write(CLEAR_LINE);
    deps.out('');
    deps.out(`  Could not save the cards to ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (tty && options.preview) {
    // Only terminals that draw real images get a preview; character art of a card is too coarse to show anything.
    // The strip is already indented two spaces and ends without a newline.
    const strip = await previewStrip(renderer, cards.map((card) => ({ template: card.id as StoryTemplate, png: card.png })), { env: deps.env, columns: deps.columns });
    if (strip) {
      deps.out('');
      deps.out(strip);
    }
  }

  deps.out('');
  deps.out(`  Saved to ${outDir}`);
  for (const card of cards) deps.out(`    ${dim(card.fileName, tty)}`);

  const share = options.qr === 'yes' || (options.qr === 'ask' && tty && (await deps.ask('\n  Send them to your phone?')));
  if (!share) {
    if (tty && deps.platform === 'darwin' && (await deps.ask('\n  Show them in Finder?'))) deps.reveal(join(outDir, cards[0]!.fileName));
    deps.out('');
    return 0;
  }

  const address = deps.lanAddress();
  if (!address) {
    deps.out('');
    deps.out('  No Wi-Fi or Ethernet network found, so a phone cannot reach this computer. The cards are saved above;');
    deps.out('  AirDrop them, or connect to a network and run `tokengraph story --qr`.');
    deps.out('');
    return 0;
  }

  let server;
  try {
    server = await deps.startShare({
      address,
      cards,
      handle: data.handle,
      onEvent: (event) => {
        if (event.kind === 'page') deps.out(`  ${tty ? '📱' : '-'} Phone connected`);
        else if (event.kind === 'saved') deps.out(`  ${tty ? '✓' : '-'} ${cards.find((c) => c.id === event.id)?.title ?? event.id} downloaded`);
      },
    });
  } catch (error) {
    deps.out('');
    deps.out(`  Could not start sharing: ${error instanceof Error ? error.message : String(error)}`);
    deps.out('  The cards are saved above.');
    deps.out('');
    return 1;
  }

  // The code comes last so it sits at the bottom of the window, whole, with only one line under it.
  const qr = qrLines(qrMatrix(server.url), { color: tty });
  deps.out('');
  deps.out(`  Scan with your phone's camera  ${dim(server.url, tty)}`);
  deps.out('');
  deps.out(dim('  Your phone and this computer must be on the same Wi-Fi. Office and guest networks may block it.', tty));
  if (deps.platform === 'darwin') deps.out(dim('  If macOS asks whether node may accept incoming connections, choose Allow.', tty));
  if (tty && deps.rows !== undefined && deps.rows < qr.length + 3) deps.out(bold('  Make this window taller to see the whole code.', tty));
  deps.out('');
  for (const line of qr) deps.out(`  ${line}`);
  deps.out('');
  deps.out(dim('  Press Ctrl+C when you are done.', tty));
  deps.out('');

  const release = deps.onInterrupt(() => server.stop());
  const reason = await server.done;
  release();
  deps.out(`  ${STOP_MESSAGES[reason]}`);
  deps.out('');
  return 0;
}
