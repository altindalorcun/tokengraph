import { demoStory } from '@tokengraph/core';
import { describe, expect, it, vi } from 'vitest';
import { parseStoryArgs, runStory, safeFileHandle, type StoryDeps } from '../src/commands/story.js';

const fakeRenderer = async () => ({
  render: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  rasterize: async () => ({ width: 2, height: 2, rgba: new Uint8Array(16), png: new Uint8Array(4) }),
});

function deps(overrides: Partial<StoryDeps> = {}) {
  const written: string[] = [];
  const output: string[] = [];
  const base: Partial<StoryDeps> = {
    isTTY: true,
    env: { TERM_PROGRAM: 'Apple_Terminal' },
    columns: 100,
    platform: 'linux',
    home: '/home/me',
    loadData: async (range, handle) => ({ ...demoStory(range, new Date('2026-10-11T12:00:00Z')), handle: handle ?? 'octocat', demo: false }),
    renderer: fakeRenderer,
    writeFile: async (path) => {
      written.push(path);
    },
    exists: (path) => path === '/home/me/Downloads',
    ask: async () => false,
    lanAddress: () => '127.0.0.1',
    reveal: () => undefined,
    out: (text) => output.push(text),
    onInterrupt: () => () => undefined,
    ...overrides,
  };
  return { deps: base, written, output };
}

describe('parseStoryArgs', () => {
  it('reads the defaults and validates values', () => {
    expect(parseStoryArgs({})).toEqual({ templates: ['skyline', 'receipt', 'sticker'], range: 'today', showCost: true, qr: 'ask', preview: true });
    expect(parseStoryArgs({ template: 'receipt', range: '7d', 'no-cost': true, qr: true, 'no-preview': true, out: '/x', handle: 'me' })).toEqual({
      templates: ['receipt'], range: '7d', showCost: false, qr: 'yes', preview: false, outDir: '/x', handle: 'me',
    });
    expect(parseStoryArgs({ 'no-qr': true })).toMatchObject({ qr: 'no' });
    expect(parseStoryArgs({ template: 'poster' })).toBe('--template must be skyline, receipt, sticker or all.');
    expect(parseStoryArgs({ range: '2y' })).toBe('--range must be today, 7d, 30d or 1y.');
    expect(parseStoryArgs({ qr: true, 'no-qr': true })).toBe('Choose one of --qr and --no-qr.');
  });
});

describe('safeFileHandle', () => {
  it('keeps only file-name safe characters', () => {
    expect(safeFileHandle('octocat')).toBe('octocat');
    expect(safeFileHandle('John Smith')).toBe('John-Smith');
    expect(safeFileHandle('a/b')).toBe('a-b');
    expect(safeFileHandle('..\\x:y')).toBe('..-x-y');
    expect(safeFileHandle('')).toBe('me');
  });
});

describe('runStory', () => {
  it('saves every card to ~/Downloads with its file name', async () => {
    const { deps: d, written } = deps();
    expect(await runStory(parseStoryArgs({ 'no-qr': true }) as never, d)).toBe(0);
    expect(written).toEqual([
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-receipt.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-sticker.png',
    ]);
  });

  it('falls back to the home folder without a Downloads folder', async () => {
    const { deps: d, written } = deps({ exists: () => false });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, d);
    expect(written).toEqual(['/home/me/tokengraph-octocat-2026-10-11-skyline.png']);
  });

  it('keeps the handle as typed on the card but makes the file name safe', async () => {
    const render = vi.fn(async () => new Uint8Array([1]));
    const { deps: d, written } = deps({ renderer: async () => ({ ...(await fakeRenderer()), render }) });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline', handle: 'John Smith' }) as never, d);
    expect(render).toHaveBeenCalledWith('skyline', expect.objectContaining({ data: expect.objectContaining({ handle: 'John Smith' }) }));
    expect(written).toEqual(['/home/me/Downloads/tokengraph-John-Smith-2026-10-11-skyline.png']);

    written.length = 0;
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline', handle: 'a/b' }) as never, d);
    expect(written).toEqual(['/home/me/Downloads/tokengraph-a-b-2026-10-11-skyline.png']);
  });

  it('shares when the person says yes and stops when the server stops', async () => {
    const startShare = vi.fn(async () => ({ url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('all-saved' as const), stop: () => undefined }));
    const { deps: d, output } = deps({ ask: async () => true, startShare });
    expect(await runStory(parseStoryArgs({}) as never, d)).toBe(0);
    expect(startShare).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('http://127.0.0.1:1/tok/');
  });

  it('stops the server on Ctrl+C and says so', async () => {
    let resolveDone: (reason: 'stopped') => void = () => undefined;
    const done = new Promise<'stopped'>((resolve) => {
      resolveDone = resolve;
    });
    const stop = vi.fn(() => resolveDone('stopped'));
    const startShare = vi.fn(async () => ({ url: 'http://127.0.0.1:1/tok/', done, stop }));
    let interrupt: () => void = () => undefined;
    const release = vi.fn();
    const { deps: d, output } = deps({
      startShare,
      onInterrupt: (handler) => {
        interrupt = handler;
        return release;
      },
    });
    const finished = runStory(parseStoryArgs({ qr: true }) as never, d);
    await vi.waitFor(() => expect(startShare).toHaveBeenCalled());
    await vi.waitFor(() => expect(output.join('\n')).toContain('Ctrl+C'));
    interrupt();
    expect(await finished).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('Stopped sharing.');
  });

  it('explains when there is no local network and still succeeds', async () => {
    const { deps: d, output } = deps({ lanAddress: () => null });
    expect(await runStory(parseStoryArgs({ qr: true }) as never, d)).toBe(0);
    expect(output.join('\n')).toMatch(/Wi-Fi|network/);
  });

  it('never asks or previews without a terminal, and prints no escape codes', async () => {
    const ask = vi.fn(async () => true);
    const rasterize = vi.fn(async () => ({ width: 2, height: 2, rgba: new Uint8Array(16), png: new Uint8Array(4) }));
    const { deps: d, output } = deps({ isTTY: false, ask, renderer: async () => ({ ...(await fakeRenderer()), rasterize }) });
    await runStory(parseStoryArgs({}) as never, d);
    expect(ask).not.toHaveBeenCalled();
    expect(rasterize).not.toHaveBeenCalled();
    expect(output.join('\n')).not.toContain('\x1b');
    expect(output.join('\n')).not.toContain('✓');
  });

  it('reports a folder it cannot write to instead of crashing', async () => {
    const { deps: d, output } = deps({
      writeFile: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(await runStory(parseStoryArgs({ 'no-qr': true }) as never, d)).toBe(1);
    expect(output.join('\n')).toContain('EACCES');
  });
});
