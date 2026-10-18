import { STORY_SIZES, type StoryTemplate } from '@tokengraph/core';
import type { StoryRenderer } from './render.js';
import { detectImageProtocol, itermImage, kittyImage } from './term-image.js';

const GAP = 24;
const THUMB_WIDTH = 270;

/** The cards side by side as one picture, or null where the terminal cannot draw a real image. */
export async function previewStrip(
  renderer: StoryRenderer,
  cards: readonly { template: StoryTemplate; png: Uint8Array }[],
  options: { env: NodeJS.ProcessEnv; columns: number },
): Promise<string | null> {
  const protocol = detectImageProtocol(options.env);
  if (protocol === 'none') return null;
  const thumbs = cards.map((card) => ({ ...card, height: Math.round((STORY_SIZES[card.template].height / STORY_SIZES[card.template].width) * THUMB_WIDTH) }));
  const width = thumbs.length * THUMB_WIDTH + (thumbs.length - 1) * GAP;
  const height = Math.max(...thumbs.map((thumb) => thumb.height));
  const strip = (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', width, height }}>
      {thumbs.map((thumb, index) => (
        <img
          key={thumb.template}
          src={`data:image/png;base64,${Buffer.from(thumb.png).toString('base64')}`}
          width={THUMB_WIDTH}
          height={thumb.height}
          style={{ marginLeft: index === 0 ? 0 : GAP, borderRadius: 18 }}
        />
      ))}
    </div>
  );
  const widthCells = Math.max(30, Math.min(options.columns - 4, 120));
  const { png } = await renderer.rasterize(strip, { width, height }, Math.min(width, widthCells * 10));
  return `  ${protocol === 'iterm' ? itermImage(png, widthCells) : kittyImage(png, widthCells)}\n`;
}
