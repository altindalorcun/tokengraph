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
  /** `auto`: a terminal shows the QR code; anything else only saves the files. */
  qr: 'auto' | 'yes' | 'no';
  /** Also save the PNGs on this computer (--save, --out or --no-qr). Without it a shared card stays in memory. */
  save: boolean;
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
  /** Reads single key presses while the QR code is up; returns the function that gives the terminal back. */
  onKey: (handler: (key: string) => void) => () => void;
}

export function parseStoryArgs(values: Record<string, string | boolean | undefined>): StoryCommandOptions | string {
  const template = values['template'] ?? 'all';
  const templates = template === 'all' ? [...STORY_TEMPLATES] : STORY_TEMPLATES.filter((t) => t === template);
  if (templates.length === 0) return '--template must be skyline, receipt, sticker or all.';
  const range = values['range'] ?? 'ask';
  if (range !== 'ask' && !STORY_RANGES.includes(range as StoryRange)) return '--range must be today, 7d, 30d or 1y.';
  if (values['qr'] && values['no-qr']) return 'Choose one of --qr and --no-qr.';
  const qr = values['qr'] ? 'yes' : values['no-qr'] ? 'no' : 'auto';
  const options: StoryCommandOptions = {
    templates,
    range: range as StoryRange | 'ask',
    showCost: !values['no-cost'],
    qr,
    save: qr === 'no' || values['save'] === true || typeof values['out'] === 'string',
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
    onKey: (handler) => listenForKeys(process.stdin, handler),
  };
}

/** Raw mode turns Ctrl+C into the key "\x03", so the caller must handle it; the release puts the terminal back as it was. */
export function listenForKeys(
  stdin: Pick<NodeJS.ReadStream, 'on' | 'off' | 'setRawMode' | 'resume' | 'pause'> & { isTTY?: boolean; isRaw?: boolean },
  handler: (key: string) => void,
): () => void {
  if (!stdin.isTTY) return () => undefined;
  const wasRaw = stdin.isRaw === true;
  const listener = (chunk: Buffer | string) => {
    for (const key of String(chunk)) handler(key);
  };
  try {
    stdin.setRawMode(true);
  } catch {
    return () => undefined;
  }
  stdin.on('data', listener);
  stdin.resume();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    stdin.off('data', listener);
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* the terminal is gone */
    }
    stdin.pause();
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
      cards.push({ id: template, title: STORY_TEMPLATE_LABELS[template].name, fileName, png, ...STORY_SIZES[template] });
      deps.out(`${tty ? CLEAR_LINE : ''}  ${tty ? '✓' : '-'} ${label}`);
    }
  } catch (error) {
    if (tty) deps.write(CLEAR_LINE);
    deps.out('');
    deps.out(`  Could not draw the cards: ${error instanceof Error ? error.message : String(error)}`);
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

  let savedLocally = false;
  /** Writes every card to outDir and lists them; false (with the reason printed) when the folder cannot be written. */
  const saveCards = async (): Promise<boolean> => {
    try {
      for (const card of cards) await deps.writeFile(join(outDir, card.fileName), card.png);
    } catch (error) {
      deps.out('');
      deps.out(`  Could not save the cards to ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    savedLocally = true;
    deps.out('');
    deps.out(`  ${tty ? '✓ ' : ''}Saved to ${outDir}`);
    for (const card of cards) deps.out(`    ${dim(card.fileName, tty)}`);
    return true;
  };
  /** The way out when the phone cannot be reached: the cards are not lost, they can still go to disk. */
  const offerSave = async (): Promise<number> => {
    if (savedLocally) {
      deps.out('');
      return 0;
    }
    if (tty && (await deps.ask('\n  Save them to this computer instead?'))) {
      const ok = await saveCards();
      deps.out('');
      return ok ? 0 : 1;
    }
    if (!tty) deps.out('  Run `tokengraph story --save` to save the cards on this computer.');
    deps.out('');
    return 0;
  };

  const share = options.qr === 'yes' || (options.qr === 'auto' && tty);
  if (options.save || !share) {
    if (!(await saveCards())) return 1;
  }
  if (!share) {
    if (tty && deps.platform === 'darwin' && (await deps.ask('\n  Show them in Finder?'))) deps.reveal(join(outDir, cards[0]!.fileName));
    deps.out('');
    return 0;
  }

  const address = deps.lanAddress();
  if (!address) {
    deps.out('');
    deps.out('  No Wi-Fi or Ethernet network found, so a phone cannot reach this computer.');
    deps.out('  Connect to a network and run `tokengraph story` again, or save the cards here and AirDrop them.');
    return offerSave();
  }

  let phoneConnected = false;
  let server;
  try {
    server = await deps.startShare({
      address,
      cards,
      handle: data.handle,
      onEvent: (event) => {
        if (event.kind === 'page') {
          deps.out(`  ${tty ? '📱' : '-'} Phone connected`);
          if (!phoneConnected && tty && !savedLocally) deps.out(dim('  Press S to also save the cards on this computer.', tty));
          phoneConnected = true;
        } else if (event.kind === 'saved') deps.out(`  ${tty ? '✓' : '-'} ${cards.find((c) => c.id === event.id)?.title ?? event.id} downloaded`);
      },
    });
  } catch (error) {
    deps.out('');
    deps.out(`  Could not start sharing: ${error instanceof Error ? error.message : String(error)}`);
    return offerSave();
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

  const running = server;
  let saving: Promise<boolean> | null = null;
  const releaseInterrupt = deps.onInterrupt(() => running.stop());
  const releaseKeys = tty
    ? deps.onKey((key) => {
        if (key === '\x03' || key === '\x04' || key === 'q' || key === 'Q') running.stop();
        else if ((key === 's' || key === 'S') && !savedLocally && !saving) {
          saving = saveCards().finally(() => {
            saving = null;
          });
        }
      })
    : () => undefined;
  const reason = await server.done;
  releaseKeys();
  releaseInterrupt();
  if (saving) await saving;
  deps.out(`  ${STOP_MESSAGES[reason]}`);
  if (!phoneConnected && !savedLocally) {
    deps.out(dim('  The phone never opened the page? `tokengraph story --save` saves the cards on this computer instead.', tty));
  }
  deps.out('');
  return 0;
}
