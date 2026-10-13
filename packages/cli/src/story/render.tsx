import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori, { type Font } from 'satori';
import { STORY_SIZES, type StoryTemplate } from '@tokengraph/core';
import type { ReactElement } from 'react';
import { assetsDir } from '../bin-path.js';
import type { CardContext } from './cards/context.js';
import { ReceiptCard } from './cards/receipt-card.js';
import { SkylineCard } from './cards/skyline-card.js';
import { StickerCard } from './cards/sticker-card.js';
import { MONO, SANS } from './parts.js';

type Weight = 400 | 500 | 600 | 700;

const FONT_FILES: readonly { name: string; file: string; weight: Weight }[] = [
  { name: SANS, file: 'plex-sans-400.ttf', weight: 400 },
  { name: SANS, file: 'plex-sans-500.ttf', weight: 500 },
  { name: SANS, file: 'plex-sans-600.ttf', weight: 600 },
  { name: SANS, file: 'plex-sans-700.ttf', weight: 700 },
  { name: MONO, file: 'plex-mono-400.ttf', weight: 400 },
  { name: MONO, file: 'plex-mono-500.ttf', weight: 500 },
  { name: MONO, file: 'plex-mono-600.ttf', weight: 600 },
];

const CARDS: Record<StoryTemplate, (context: CardContext) => ReactElement> = {
  skyline: SkylineCard,
  receipt: ReceiptCard,
  sticker: StickerCard,
};

export interface StoryRenderer {
  /** A card as PNG bytes, `scale` times its full size (1 = 1080 px wide). */
  render(template: StoryTemplate, context: CardContext, scale?: number): Promise<Uint8Array>;
  /** RGBA pixels of any element tree, for the terminal preview. */
  rasterize(
    element: ReactElement,
    size: { width: number; height: number },
    fitWidth: number,
  ): Promise<{ width: number; height: number; rgba: Uint8Array; png: Uint8Array }>;
}

// resvg's WebAssembly can be initialised once per process.
let wasmReady: Promise<void> | null = null;

export async function createStoryRenderer(assets: string = assetsDir()): Promise<StoryRenderer> {
  wasmReady ??= readFile(join(assets, 'resvg.wasm')).then((bytes) => initWasm(bytes));
  const fonts: Font[] = await Promise.all(
    FONT_FILES.map(async (face) => ({
      name: face.name,
      weight: face.weight,
      style: 'normal' as const,
      data: await readFile(join(assets, 'fonts', face.file)),
    })),
  );
  await wasmReady;

  async function draw(
    element: ReactElement,
    size: { width: number; height: number },
    fit: { mode: 'original' } | { mode: 'width'; value: number } | { mode: 'zoom'; value: number },
  ) {
    const svg = await satori(element, { ...size, fonts });
    const resvg = new Resvg(svg, { fitTo: fit, font: { loadSystemFonts: false } });
    const image = resvg.render();
    try {
      return { width: image.width, height: image.height, rgba: new Uint8Array(image.pixels), png: image.asPng() };
    } finally {
      image.free();
      resvg.free();
    }
  }

  return {
    async render(template, context, scale = 1) {
      const Card = CARDS[template];
      const fit = scale === 1 ? ({ mode: 'original' } as const) : ({ mode: 'zoom', value: scale } as const);
      return (await draw(<Card {...context} />, STORY_SIZES[template], fit)).png;
    },
    rasterize(element, size, fitWidth) {
      return draw(element, size, { mode: 'width', value: fitWidth });
    },
  };
}
