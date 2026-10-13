import { afterEach, describe, expect, it, vi } from 'vitest';
import { startShareServer, type ShareEvent, type ShareServer } from '../src/share/server.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const cards = [
  { id: 'skyline', title: 'Skyline', fileName: 'a-skyline.png', width: 1080, height: 1920, png },
  { id: 'receipt', title: 'Receipt', fileName: 'a-receipt.png', width: 1080, height: 1920, png },
];

let server: ShareServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  vi.useRealTimers();
});

describe('share server', () => {
  it('serves the page and the cards under the token only', async () => {
    const events: ShareEvent[] = [];
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', onEvent: (e) => events.push(e) });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/);

    const page = await fetch(server.url, { headers: { 'user-agent': 'iPhone' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('card/skyline.png');
    expect(html).not.toMatch(/https?:\/\//);

    const image = await fetch(`${server.url}card/skyline.png`);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);

    const saved = await fetch(`${server.url}card/receipt.png?download=1`);
    expect(saved.headers.get('content-disposition')).toBe('attachment; filename="a-receipt.png"');
    await saved.arrayBuffer();

    const origin = server.url.replace(/[^/]+\/$/, '');
    expect((await fetch(origin)).status).toBe(404);
    expect((await fetch(`${origin}wrongtoken/`)).status).toBe(404);
    expect((await fetch(`${server.url}card/nope.png`)).status).toBe(404);
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(405);
    expect(events).toEqual([{ kind: 'page', userAgent: 'iPhone' }, { kind: 'saved', id: 'receipt' }]);
  });

  it('stops after every card was saved', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', afterAllSavedMs: 20 });
    for (const card of cards) await (await fetch(`${server.url}card/${card.id}.png?download=1`)).arrayBuffer();
    expect(await server.done).toBe('all-saved');
  });

  it('stops when idle and when asked', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', idleMs: 30 });
    expect(await server.done).toBe('idle');
    const other = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat' });
    other.stop();
    expect(await other.done).toBe('stopped');
  });
});
