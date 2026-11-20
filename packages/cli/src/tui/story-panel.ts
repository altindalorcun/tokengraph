import { STORY_RANGES, STORY_TEMPLATE_LABELS, STORY_TEMPLATES, type StoryRange, type StoryTemplate } from '@tokengraph/core';
import type { StopReason } from '../share/server.js';
import type { InputEvent } from './input.js';
import type { StoryEvent } from './story-session.js';

export interface StoryCardRow {
  id: StoryTemplate;
  title: string;
  status: 'waiting' | 'drawing' | 'ready' | 'downloaded';
}

/** The story cards box: pick a period, watch the cards being drawn, then share them with the phone. */
export interface StoryPanel {
  /** `failed`: the cards could not be drawn, so there is nothing to share or save. */
  step: 'range' | 'drawing' | 'ready' | 'failed';
  /** The highlighted period, an index into STORY_RANGES. */
  selected: number;
  range: StoryRange | null;
  handle: string | null;
  /** The period has no usage, so every card shows 0. */
  empty: boolean;
  cards: StoryCardRow[];
  share:
    | { state: 'starting' }
    | { state: 'live'; url: string; qr: boolean[][]; phone: boolean }
    | { state: 'offline' }
    | { state: 'failed'; reason: string }
    | { state: 'stopped'; reason: StopReason; url: string | null };
  save: { state: 'idle' } | { state: 'saving' } | { state: 'saved'; dir: string } | { state: 'failed'; reason: string };
  /** Why drawing failed (step `failed`). */
  error: string | null;
}

/** What the box asks the app to do: start a session for a period, save its cards, or close it. */
export type StoryCommand = { story: 'start'; range: StoryRange } | { story: 'save' } | { story: 'close' };

export function openStoryPanel(): StoryPanel {
  return {
    step: 'range',
    selected: 0,
    range: null,
    handle: null,
    empty: false,
    cards: STORY_TEMPLATES.map((id) => ({ id, title: STORY_TEMPLATE_LABELS[id].name, status: 'waiting' })),
    share: { state: 'starting' },
    save: { state: 'idle' },
    error: null,
  };
}

/** S works once the cards exist, and again after a save that failed. */
export function canSave(panel: StoryPanel): boolean {
  return panel.step === 'ready' && (panel.save.state === 'idle' || panel.save.state === 'failed');
}

/** Keys while the box is open. Esc and Ctrl-C close it from any step; nothing else reaches the app. */
export function storyKey(panel: StoryPanel, event: InputEvent): { panel: StoryPanel; command: StoryCommand | null } {
  const stay = { panel, command: null };
  if ((event.type === 'key' && event.key === 'escape') || (event.type === 'ctrl' && event.char === 'c')) {
    return { panel, command: { story: 'close' } };
  }
  if (panel.step === 'range') {
    if (event.type !== 'key') return stay;
    const last = STORY_RANGES.length - 1;
    if (event.key === 'up') return { panel: { ...panel, selected: Math.max(0, panel.selected - 1) }, command: null };
    if (event.key === 'down') return { panel: { ...panel, selected: Math.min(last, panel.selected + 1) }, command: null };
    if (event.key === 'enter') {
      const range = STORY_RANGES[panel.selected]!;
      return { panel: { ...panel, step: 'drawing', range }, command: { story: 'start', range } };
    }
    return stay;
  }
  if (event.type === 'char' && (event.char === 's' || event.char === 'S') && canSave(panel)) {
    return { panel: { ...panel, save: { state: 'saving' } }, command: { story: 'save' } };
  }
  return stay;
}

function withCard(panel: StoryPanel, id: string, status: StoryCardRow['status']): StoryCardRow[] {
  return panel.cards.map((card) => (card.id === id ? { ...card, status } : card));
}

/** Folds one session event into the box. */
export function applyStoryEvent(panel: StoryPanel, event: StoryEvent): StoryPanel {
  switch (event.kind) {
    case 'loaded':
      return { ...panel, handle: event.handle, empty: event.empty };
    case 'drawing':
      return { ...panel, cards: withCard(panel, event.id, 'drawing') };
    case 'drawn': {
      const cards = withCard(panel, event.id, 'ready');
      return { ...panel, cards, step: cards.every((card) => card.status !== 'waiting' && card.status !== 'drawing') ? 'ready' : panel.step };
    }
    case 'sharing':
      return { ...panel, share: { state: 'live', url: event.url, qr: event.qr, phone: false } };
    case 'phone':
      return panel.share.state === 'live' ? { ...panel, share: { ...panel.share, phone: true } } : panel;
    case 'downloaded':
      return { ...panel, cards: withCard(panel, event.id, 'downloaded') };
    case 'saving':
      return { ...panel, save: { state: 'saving' } };
    case 'saved':
      return { ...panel, save: { state: 'saved', dir: event.dir } };
    case 'save-failed':
      return { ...panel, save: { state: 'failed', reason: event.reason } };
    case 'offline':
      return { ...panel, share: { state: 'offline' } };
    case 'failed':
      return event.saveable
        ? { ...panel, share: { state: 'failed', reason: event.reason } }
        : { ...panel, step: 'failed', error: event.reason };
    case 'stopped':
      return { ...panel, share: { state: 'stopped', reason: event.reason, url: panel.share.state === 'live' ? panel.share.url : null } };
  }
}
