import { describe, expect, it } from 'vitest';
import { phonePage } from '../src/share/page.js';

const cards = [
  { id: 'skyline', title: 'Skyline', fileName: 'tg-skyline.png', width: 1080, height: 1920 },
  { id: 'receipt', title: 'Receipt "x"', fileName: 'tg-<receipt>.png', width: 1080, height: 1920 },
];

describe('phone page', () => {
  const html = phonePage(cards, { handle: 'octo<cat>' });

  it('gives every card a Save link that downloads, and the data the iPhone path needs', () => {
    expect(html).toContain(
      '<a class="btn save" href="card/skyline.png?download=1" download="tg-skyline.png" data-id="skyline" data-src="card/skyline.png" data-title="Skyline">',
    );
    expect(html).toContain('download="tg-&lt;receipt&gt;.png"');
    expect(html).toContain('data-title="Receipt &quot;x&quot;"');
    expect(html).toContain('@octo&lt;cat&gt;');
    expect(html).not.toContain('octo<cat>');
  });

  it('tells each phone the way that lands in its photos', () => {
    expect(html).toContain('<p data-hint="ios" hidden>Touch and hold a card, then tap <strong>Save to Photos</strong>.</p>');
    expect(html).toContain('<p data-hint="android" hidden>Tap <strong>Save</strong> under a card to put it in your gallery.</p>');
    expect(html).toMatch(/<div class="viewer" id="viewer" hidden role="dialog" aria-modal="true"/);
    expect(html).toContain('<strong>Touch and hold the card</strong>, then tap <strong>Save to Photos</strong>.');
    // The viewer image must keep the iPhone's touch-and-hold menu, and the hold marker must not catch the touch.
    expect(html).toContain('-webkit-touch-callout:default');
    expect(html).toMatch(/\.pulse\{[^}]*pointer-events:none/);
  });

  it('keeps the iPhone off the Files download and shares only where the sheet exists', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("if (kind !== 'ios') { markSaved(link); return; }");
    expect(script).toContain('event.preventDefault();');
    expect(script).toContain("kind === 'ios' && !!(navigator.canShare");
    expect(html).not.toContain('class="btn share"');
  });

  it('is one self-contained document', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<(link|iframe)\b/);
  });
});
