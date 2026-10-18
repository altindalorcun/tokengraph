import { demoStory, STORY_TEMPLATES } from '@tokengraph/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { STORY_CTA } from '../src/story/cards/context.js';
import { previewStrip } from '../src/story/preview.js';
import { createStoryRenderer, type StoryRenderer } from '../src/story/render.js';

describe('previewStrip', () => {
  let renderer: StoryRenderer;
  let cards: { template: (typeof STORY_TEMPLATES)[number]; png: Uint8Array }[];
  beforeAll(async () => {
    renderer = await createStoryRenderer();
    const context = { data: demoStory('today', new Date('2026-10-11T12:00:00Z')), showCost: true, cta: STORY_CTA };
    cards = [];
    for (const template of STORY_TEMPLATES) cards.push({ template, png: await renderer.render(template, context, 0.25) });
  }, 30_000);

  it('shows nothing in a terminal that cannot draw images', async () => {
    expect(await previewStrip(renderer, cards, { env: { TERM_PROGRAM: 'Apple_Terminal' }, columns: 100 })).toBeNull();
    expect(await previewStrip(renderer, cards, { env: { COLORTERM: 'truecolor' }, columns: 100 })).toBeNull();
    expect(await previewStrip(renderer, cards, { env: { TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux' }, columns: 100 })).toBeNull();
  });

  it('sends one inline image where the terminal can draw it', async () => {
    const iterm = (await previewStrip(renderer, cards, { env: { TERM_PROGRAM: 'iTerm.app' }, columns: 100 }))!;
    expect(iterm.startsWith('  \x1b]1337;File=inline=1;')).toBe(true);
    expect(iterm).toContain('width=96;');
    const kitty = (await previewStrip(renderer, cards, { env: { KITTY_WINDOW_ID: '3' }, columns: 100 }))!;
    expect(kitty.startsWith('  \x1b_Gf=100,a=T,q=2,c=96,m=')).toBe(true);
  }, 30_000);
});
