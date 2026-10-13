import { demoStory, STORY_SIZES, STORY_TEMPLATES } from '@tokengraph/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { STORY_CTA } from '../src/story/cards/context.js';
import { createStoryRenderer, type StoryRenderer } from '../src/story/render.js';

function size(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe('story renderer', () => {
  let renderer: StoryRenderer;
  beforeAll(async () => {
    renderer = await createStoryRenderer();
  }, 30_000);

  for (const template of STORY_TEMPLATES) {
    it(`draws ${template} at full size and scaled`, async () => {
      const context = { data: demoStory('today', new Date('2026-10-11T12:00:00Z')), showCost: true, cta: STORY_CTA };
      const full = await renderer.render(template, context);
      expect([...full.slice(0, 4)]).toEqual(PNG_SIGNATURE);
      expect(size(full)).toEqual(STORY_SIZES[template]);
      const small = await renderer.render(template, context, 0.25);
      expect(size(small).width).toBe(270);
    }, 30_000);
  }

  it('rasterizes an element to RGBA for the terminal preview', async () => {
    const out = await renderer.rasterize(<div style={{ display: 'flex', width: 40, height: 20, background: '#ff0000' }} />, { width: 40, height: 20 }, 20);
    expect(out.width).toBe(20);
    expect(out.rgba.length).toBe(out.width * out.height * 4);
    expect([...out.rgba.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });
});
