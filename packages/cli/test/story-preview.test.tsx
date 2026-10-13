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

  const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

  it('draws half blocks in a terminal without images, 256 colours then truecolor', async () => {
    const plain = await previewStrip(renderer, cards, { env: { TERM_PROGRAM: 'Apple_Terminal' }, columns: 100 });
    const lines = plain.split('\n');
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(visible(line)).toBe(`  ${'▀'.repeat(96)}`);
    expect(plain).toContain('\x1b[38;5;');
    expect(plain).not.toContain('\x1b[38;2;');
    expect(await previewStrip(renderer, cards, { env: { COLORTERM: 'truecolor' }, columns: 100 })).toContain('\x1b[38;2;');
  }, 30_000);

  it('stays inside a narrow terminal', async () => {
    const out = await previewStrip(renderer, cards, { env: {}, columns: 50 });
    for (const line of out.split('\n')) expect(visible(line).length).toBe(2 + 46);
  }, 30_000);

  it('sends one inline image where the terminal can draw it', async () => {
    const iterm = await previewStrip(renderer, cards, { env: { TERM_PROGRAM: 'iTerm.app' }, columns: 100 });
    expect(iterm.startsWith('  \x1b]1337;File=inline=1;')).toBe(true);
    expect(iterm).toContain('width=96;');
    const kitty = await previewStrip(renderer, cards, { env: { KITTY_WINDOW_ID: '3' }, columns: 100 });
    expect(kitty.startsWith('  \x1b_Gf=100,a=T,c=96,m=')).toBe(true);
  }, 30_000);
});
