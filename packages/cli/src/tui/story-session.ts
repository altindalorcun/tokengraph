import { STORY_TEMPLATES, type StoryRange, type StoryTemplate } from '@tokengraph/core';
import { defaultStoryDeps, renderStoryCards, storyOutDir, writeStoryCards, type StoryDeps } from '../commands/story.js';
import { qrMatrix } from '../share/qr.js';
import type { ShareCard, ShareServer, StopReason } from '../share/server.js';

/** What a story session reports to the view, in the order it happens. */
export type StoryEvent =
  | { kind: 'loaded'; handle: string; empty: boolean }
  | { kind: 'drawing'; id: StoryTemplate }
  | { kind: 'drawn'; id: StoryTemplate }
  | { kind: 'sharing'; url: string; qr: boolean[][] }
  | { kind: 'phone' }
  | { kind: 'downloaded'; id: string }
  | { kind: 'saving' }
  | { kind: 'saved'; dir: string }
  | { kind: 'save-failed'; reason: string }
  /** No network a phone could reach; the cards are drawn and can still be saved. */
  | { kind: 'offline' }
  /** Drawing or sharing failed; `saveable` says whether the cards exist to save instead. */
  | { kind: 'failed'; reason: string; saveable: boolean }
  | { kind: 'stopped'; reason: StopReason };

export interface StorySession {
  /** Saves the cards to the downloads folder; ignored before they are drawn, while saving, and once saved. */
  save(): void;
  /** Stops sharing; no event arrives after this. */
  stop(): void;
}

export type StorySessionDeps = Pick<
  StoryDeps,
  'loadData' | 'renderer' | 'lanAddress' | 'startShare' | 'writeFile' | 'platform' | 'home' | 'env' | 'downloadsDir' | 'exists'
>;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The story command without a terminal: draws every card for `range`, then shares them with a phone
 * on the same network. Everything it has to say goes to `emit`; it never writes to stdout.
 */
export function startStorySession(range: StoryRange, emit: (event: StoryEvent) => void, deps: StorySessionDeps = defaultStoryDeps()): StorySession {
  let stopped = false;
  let cards: ShareCard[] | null = null;
  let server: ShareServer | null = null;
  let saving = false;
  let saved = false;
  const send = (event: StoryEvent): void => {
    if (!stopped) emit(event);
  };

  const run = async (): Promise<void> => {
    let drawn: ShareCard[];
    let handle: string;
    try {
      const data = await deps.loadData(range);
      handle = data.handle;
      send({ kind: 'loaded', handle: data.handle, empty: data.total === 0 });
      const renderer = await deps.renderer();
      drawn = await renderStoryCards(renderer, data, { templates: STORY_TEMPLATES, range, showCost: true }, (id, phase) => {
        send({ kind: phase, id });
      });
    } catch (error) {
      send({ kind: 'failed', reason: `Could not draw the cards: ${message(error)}`, saveable: false });
      return;
    }
    cards = drawn;
    if (stopped) return;
    const address = deps.lanAddress();
    if (!address) {
      send({ kind: 'offline' });
      return;
    }
    let started: ShareServer;
    try {
      started = await deps.startShare({
        address,
        cards: drawn,
        handle,
        onEvent: (event) => {
          if (event.kind === 'page') send({ kind: 'phone' });
          else if (event.kind === 'saved') send({ kind: 'downloaded', id: event.id });
        },
      });
    } catch (error) {
      send({ kind: 'failed', reason: `Could not start sharing: ${message(error)}`, saveable: true });
      return;
    }
    if (stopped) {
      started.stop();
      return;
    }
    server = started;
    send({ kind: 'sharing', url: started.url, qr: qrMatrix(started.url) });
    const reason = await started.done;
    send({ kind: 'stopped', reason });
  };
  void run();

  return {
    save() {
      const ready = cards;
      if (!ready || saving || saved || stopped) return;
      saving = true;
      send({ kind: 'saving' });
      const dir = storyOutDir(deps);
      writeStoryCards(ready, dir, deps).then(
        () => {
          saved = true;
          send({ kind: 'saved', dir });
        },
        (error: unknown) => send({ kind: 'save-failed', reason: `Could not save the cards to ${dir}: ${message(error)}` }),
      ).finally(() => {
        saving = false;
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      server?.stop();
    },
  };
}
