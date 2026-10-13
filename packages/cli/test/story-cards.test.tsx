import { demoStory } from '@tokengraph/core';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { STORY_CTA } from '../src/story/cards/context.js';
import { ReceiptCard } from '../src/story/cards/receipt-card.js';
import { SkylineCard } from '../src/story/cards/skyline-card.js';
import { StickerCard } from '../src/story/cards/sticker-card.js';

/** Every string a card prints, in order, found by expanding function components down to host elements. */
function texts(node: ReactNode, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) for (const child of node) texts(child, out);
  else if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    texts(typeof element.type === 'function' ? (element.type as (props: unknown) => ReactNode)(element.props) : element.props.children, out);
  }
  return out;
}

const own = { ...demoStory('30d', new Date('2026-10-11T12:00:00Z')), demo: false, handle: 'octocat' };
const context = { data: own, showCost: true, cta: STORY_CTA };

describe('story cards name the person and the command', () => {
  for (const [name, Card] of [
    ['skyline', SkylineCard],
    ['receipt', ReceiptCard],
    ['sticker', StickerCard],
  ] as const) {
    it(`${name} prints @handle and ${STORY_CTA}, never a profile URL`, () => {
      const printed = texts(Card(context)).join('');
      expect(printed).toContain('@octocat');
      expect(printed).toContain(STORY_CTA);
      expect(printed).not.toContain('/u/');
    });
  }

  it('a sample account is not presented as a person', () => {
    const printed = texts(ReceiptCard({ ...context, data: { ...own, demo: true } })).join('');
    expect(printed).toContain('SAMPLE ACCOUNT');
    expect(printed).toContain(STORY_CTA);
  });
});
