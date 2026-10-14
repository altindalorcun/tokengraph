import { connect } from 'node:net';
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
    expect(saved.headers.get('content-disposition')).toBe(
      `attachment; filename="a-receipt.png"; filename*=UTF-8''a-receipt.png`,
    );
    await saved.arrayBuffer();

    const origin = server.url.replace(/[^/]+\/$/, '');
    expect((await fetch(origin)).status).toBe(404);
    expect((await fetch(`${origin}wrongtoken/`)).status).toBe(404);
    expect((await fetch(`${server.url}card/nope.png`)).status).toBe(404);
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(405);
    expect(events).toEqual([
      { kind: 'page', userAgent: 'iPhone' },
      { kind: 'viewed', id: 'skyline' },
      { kind: 'saved', id: 'receipt' },
    ]);
  });

  it('reports a plain image GET once per card as viewed (the iPhone touch-and-hold path), never a HEAD', async () => {
    const events: ShareEvent[] = [];
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', onEvent: (e) => events.push(e) });
    await (await fetch(`${server.url}card/skyline.png`, { method: 'HEAD' })).arrayBuffer();
    for (let i = 0; i < 3; i += 1) await (await fetch(`${server.url}card/skyline.png`)).arrayBuffer();
    await (await fetch(`${server.url}card/receipt.png`)).arrayBuffer();
    expect(events).toEqual([
      { kind: 'viewed', id: 'skyline' },
      { kind: 'viewed', id: 'receipt' },
    ]);
  });

  it('does not stop after every card was only viewed', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', afterAllSavedMs: 20, idleMs: 150 });
    for (const card of cards) await (await fetch(`${server.url}card/${card.id}.png`)).arrayBuffer();
    expect(await server.done).toBe('idle');
  });

  it('does not let requests to a wrong path keep the server alive', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', idleMs: 80 });
    const origin = server.url.replace(/[^/]+\/$/, '');
    const started = Date.now();
    const scanner = setInterval(() => void fetch(`${origin}wrongtoken/`).then((r) => r.arrayBuffer()).catch(() => undefined), 15);
    try {
      expect(await server.done).toBe('idle');
    } finally {
      clearInterval(scanner);
    }
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('keeps the idle timer alive for requests under the token', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat', idleMs: 120 });
    const started = Date.now();
    const poll = setInterval(() => void fetch(server!.url).then((r) => r.arrayBuffer()).catch(() => undefined), 30);
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(poll);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(await Promise.race([server.done, Promise.resolve('still-running')])).toBe('still-running');
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

  it('survives request targets that URL parsing rejects', async () => {
    server = await startShareServer({ address: '127.0.0.1', cards, handle: 'octocat' });
    const { hostname, port } = new URL(server.url);
    for (const target of ['//', '//[', 'http://[/']) {
      const reply = await new Promise<string>((resolve) => {
        const socket = connect(Number(port), hostname);
        let received = '';
        socket.on('data', (chunk) => (received += chunk));
        socket.on('close', () => resolve(received));
        socket.on('error', () => resolve(received));
        socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 404/);
    }
    expect((await fetch(server.url)).status).toBe(200);
  });

  it('builds a safe Content-Disposition and the CSP forbids base, forms and framing', async () => {
    const odd = { ...cards[0]!, id: 'sticker', fileName: 'my "card".png' };
    server = await startShareServer({ address: '127.0.0.1', cards: [odd], handle: 'octocat' });
    const saved = await fetch(`${server.url}card/sticker.png?download=1`);
    expect(saved.headers.get('content-disposition')).toBe(
      `attachment; filename="my--card-.png"; filename*=UTF-8''my%20%22card%22.png`,
    );
    await saved.arrayBuffer();
    const csp = (await fetch(server.url)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('keeps serving when the event callback throws', async () => {
    server = await startShareServer({
      address: '127.0.0.1',
      cards,
      handle: 'octocat',
      onEvent: () => {
        throw new Error('boom');
      },
    });
    expect((await fetch(server.url)).status).toBe(200);
    expect((await fetch(`${server.url}card/skyline.png?download=1`)).status).toBe(200);
    expect((await fetch(server.url)).status).toBe(200);
  });
});
