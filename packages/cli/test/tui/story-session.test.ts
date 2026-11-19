import { demoStory } from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { startShareServer } from '../../src/share/server.js';
import { startStorySession, type StoryEvent, type StorySessionDeps } from '../../src/tui/story-session.js';

const fakeRenderer = async () => ({
  render: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  rasterize: async () => ({ width: 2, height: 2, rgba: new Uint8Array(16), png: new Uint8Array(4) }),
});

function deps(overrides: Partial<StorySessionDeps> = {}) {
  const written: string[] = [];
  const base: StorySessionDeps = {
    platform: 'linux',
    home: '/home/me',
    env: {},
    loadData: async (range) => ({ ...demoStory(range, new Date('2026-10-11T12:00:00Z')), handle: 'octocat', demo: false }),
    renderer: fakeRenderer,
    writeFile: async (path) => {
      written.push(path);
    },
    exists: (path) => path === '/home/me/Downloads',
    downloadsDir: () => null,
    lanAddress: () => '127.0.0.1',
    startShare: startShareServer,
    ...overrides,
  };
  return { deps: base, written };
}

/** Collects events and resolves once one of `kind` arrives. */
function recorder() {
  const events: StoryEvent[] = [];
  const waiters: { kind: StoryEvent['kind']; done: (event: StoryEvent) => void }[] = [];
  const emit = (event: StoryEvent): void => {
    events.push(event);
    for (const waiter of waiters.filter((w) => w.kind === event.kind)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.done(event);
    }
  };
  const next = <K extends StoryEvent['kind']>(kind: K): Promise<Extract<StoryEvent, { kind: K }>> => {
    const seen = events.find((event) => event.kind === kind);
    if (seen) return Promise.resolve(seen as Extract<StoryEvent, { kind: K }>);
    return new Promise((done) => waiters.push({ kind, done: done as (event: StoryEvent) => void }));
  };
  return { events, emit, next };
}

describe('startStorySession', () => {
  it('draws every card, shares them with a QR code and reports the phone and its downloads', async () => {
    const { deps: d } = deps();
    const r = recorder();
    const session = startStorySession('7d', r.emit, d);
    const sharing = await r.next('sharing');
    expect(sharing.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/$/);
    expect(sharing.qr.length).toBeGreaterThan(20);
    expect(r.events.map((e) => (e.kind === 'drawing' || e.kind === 'drawn' ? `${e.kind}:${e.id}` : e.kind))).toEqual([
      'loaded', 'drawing:skyline', 'drawn:skyline', 'drawing:receipt', 'drawn:receipt', 'drawing:sticker', 'drawn:sticker', 'sharing',
    ]);
    expect(r.events[0]).toEqual({ kind: 'loaded', handle: 'octocat', empty: false });

    await fetch(sharing.url).then((res) => res.text());
    await r.next('phone');
    await fetch(`${sharing.url}card/receipt.png?download=1`).then((res) => res.arrayBuffer());
    expect(await r.next('downloaded')).toEqual({ kind: 'downloaded', id: 'receipt' });
    session.stop();
  });

  it('saves the cards to the downloads folder once, and only after they are drawn', async () => {
    const { deps: d, written } = deps();
    const r = recorder();
    const session = startStorySession('today', r.emit, d);
    session.save(); // nothing drawn yet
    await r.next('sharing');
    expect(written).toEqual([]);
    session.save();
    session.save(); // already saving
    expect(await r.next('saved')).toEqual({ kind: 'saved', dir: '/home/me/Downloads' });
    session.save(); // already saved
    await Promise.resolve();
    expect(written).toEqual([
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-receipt.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-sticker.png',
    ]);
    expect(r.events.filter((e) => e.kind === 'saving')).toHaveLength(1);
    session.stop();
  });

  it('reports a folder it cannot write, and lets the save be tried again', async () => {
    let fail = true;
    const { deps: d } = deps({
      writeFile: async () => {
        if (fail) throw new Error('read-only');
      },
    });
    const r = recorder();
    const session = startStorySession('today', r.emit, d);
    await r.next('sharing');
    session.save();
    expect(await r.next('save-failed')).toEqual({ kind: 'save-failed', reason: 'Could not save the cards to /home/me/Downloads: read-only' });
    await new Promise((done) => setTimeout(done, 0));
    fail = false;
    session.save();
    await r.next('saved');
    session.stop();
  });

  it('says so when no network is found, and the cards can still be saved', async () => {
    const { deps: d, written } = deps({ lanAddress: () => null });
    const r = recorder();
    const session = startStorySession('today', r.emit, d);
    await r.next('offline');
    session.save();
    await r.next('saved');
    expect(written).toHaveLength(3);
    expect(r.events.some((e) => e.kind === 'sharing')).toBe(false);
  });

  it('reports a card that cannot be drawn and a server that cannot start', async () => {
    const broken = deps({ renderer: async () => ({ ...(await fakeRenderer()), render: async () => { throw new Error('no fonts'); } }) });
    const a = recorder();
    startStorySession('today', a.emit, broken.deps);
    expect(await a.next('failed')).toEqual({ kind: 'failed', reason: 'Could not draw the cards: no fonts', saveable: false });

    const busy = deps({ startShare: async () => { throw new Error('EADDRINUSE'); } });
    const b = recorder();
    startStorySession('today', b.emit, busy.deps);
    expect(await b.next('failed')).toEqual({ kind: 'failed', reason: 'Could not start sharing: EADDRINUSE', saveable: true });
  });

  it('reports an empty range', async () => {
    const { deps: d } = deps({ loadData: async (range) => ({ ...demoStory(range, new Date('2026-10-11T12:00:00Z')), handle: 'octocat', demo: false, total: 0 }) });
    const r = recorder();
    const session = startStorySession('today', r.emit, d);
    expect(await r.next('loaded')).toEqual({ kind: 'loaded', handle: 'octocat', empty: true });
    session.stop();
  });

  it('stops the server and goes quiet once stopped', async () => {
    let stopped = 0;
    const { deps: d } = deps({
      startShare: async (options) => {
        const server = await startShareServer(options);
        return { ...server, stop: () => { stopped += 1; server.stop(); } };
      },
    });
    const r = recorder();
    const session = startStorySession('today', r.emit, d);
    await r.next('sharing');
    session.stop();
    session.stop();
    await new Promise((done) => setTimeout(done, 10));
    expect(stopped).toBe(1);
    expect(r.events.some((e) => e.kind === 'stopped')).toBe(false);
  });

  it('reports the server stopping on its own', async () => {
    const { deps: d } = deps({ startShare: (options) => startShareServer({ ...options, idleMs: 20 }) });
    const r = recorder();
    startStorySession('today', r.emit, d);
    expect(await r.next('stopped')).toEqual({ kind: 'stopped', reason: 'idle' });
  });
});
