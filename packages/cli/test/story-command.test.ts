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
    downloadsDir: () => null,
    ask: async () => false,
    choose: async () => 0,
    lanAddress: () => '127.0.0.1',
    reveal: () => undefined,
    out: (text) => output.push(text),
    write: (text) => output.push(text),
    onInterrupt: () => () => undefined,
    ...overrides,
  };
  return { deps: base, written, output };
}

describe('parseStoryArgs', () => {
  it('reads the defaults and validates values', () => {
    expect(parseStoryArgs({})).toEqual({ templates: ['skyline', 'receipt', 'sticker'], range: 'ask', showCost: true, qr: 'ask', preview: true });
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

  it("uses the OS's own downloads folder, and ~/Downloads when that one is missing", async () => {
    const localized = deps({ downloadsDir: () => '/home/me/İndirilenler', exists: (path) => path === '/home/me/İndirilenler' });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, localized.deps);
    expect(localized.written).toEqual(['/home/me/İndirilenler/tokengraph-octocat-2026-10-11-skyline.png']);

    const gone = deps({ downloadsDir: () => 'D:\\Gone' });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, gone.deps);
    expect(gone.written).toEqual(['/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png']);
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

  it('does not share when the question is aborted or answered no', async () => {
    const startShare = vi.fn();
    const { deps: d, output } = deps({ ask: async () => false, startShare });
    expect(await runStory(parseStoryArgs({}) as never, d)).toBe(0);
    expect(startShare).not.toHaveBeenCalled();
    expect(output.join('\n')).not.toContain('Scan with');
  });

  it('builds Windows paths on Windows', async () => {
    const { deps: d, written } = deps({ platform: 'win32', home: 'C:\\Users\\me', exists: (path) => path === 'C:\\Users\\me\\Downloads' });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, d);
    expect(written).toEqual(['C:\\Users\\me\\Downloads\\tokengraph-octocat-2026-10-11-skyline.png']);
  });

  it('treats an empty --out as unset', async () => {
    const { deps: d, written } = deps();
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline', out: '' }) as never, d);
    expect(written).toEqual(['/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png']);
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

  it('asks for the period in a terminal when no --range is given', async () => {
    const loadData = vi.fn(async (range: never, handle?: string) => ({ ...demoStory(range, new Date('2026-10-11T12:00:00Z')), handle: handle ?? 'octocat', demo: false }));
    const choose = vi.fn(async () => 2);
    const tty = deps({ choose, loadData });
    expect(await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, tty.deps)).toBe(0);
    expect(choose).toHaveBeenCalledWith(expect.stringContaining('period'), ['Today', '7 days', '30 days', '12 months']);
    expect(loadData).toHaveBeenLastCalledWith('30d', undefined);
    expect(tty.written[0]).toContain('-30d');

    choose.mockClear();
    const given = deps({ choose, loadData });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline', range: '7d' }) as never, given.deps);
    expect(choose).not.toHaveBeenCalled();
    expect(loadData).toHaveBeenLastCalledWith('7d', undefined);

    const plain = deps({ isTTY: false, choose, loadData });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, plain.deps);
    expect(choose).not.toHaveBeenCalled();
    expect(loadData).toHaveBeenLastCalledWith('today', undefined);
  });

  it('stops without drawing anything when the period question is closed', async () => {
    const closed = deps({ choose: async () => null });
    expect(await runStory(parseStoryArgs({ 'no-qr': true }) as never, closed.deps)).toBe(1);
    expect(closed.written).toHaveLength(0);
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

  it('prints the QR with no colour escapes when there is no terminal, and forced black on white in one', async () => {
    const startShare = vi.fn(async () => ({ url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('all-saved' as const), stop: () => undefined }));
    const plain = deps({ isTTY: false, startShare });
    await runStory(parseStoryArgs({ qr: true }) as never, plain.deps);
    expect(plain.output.join('\n')).not.toContain('\x1b');
    expect(plain.output.join('\n')).toMatch(/[█▀▄]/);

    const colored = deps({ startShare });
    await runStory(parseStoryArgs({ qr: true }) as never, colored.deps);
    expect(colored.output.join('\n')).toContain('\x1b[48;5;231m');
    expect(colored.output.join('\n')).toContain('\x1b[48;5;16m');
    expect(colored.output.join('\n')).not.toMatch(/[█▀]/);
  });

  it('puts the QR last and asks for a taller window only when it would not fit', async () => {
    const startShare = vi.fn(async () => ({ url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('all-saved' as const), stop: () => undefined }));
    const short = deps({ startShare, rows: 12 });
    await runStory(parseStoryArgs({ qr: true }) as never, short.deps);
    const text = short.output.join('\n');
    expect(text).toContain('Make this window taller');
    expect(text.lastIndexOf('\x1b[48;5;')).toBeGreaterThan(text.indexOf('Scan with your phone'));
    expect(text.lastIndexOf('\x1b[48;5;')).toBeLessThan(text.indexOf('Press Ctrl+C'));

    const tall = deps({ startShare, rows: 30 });
    await runStory(parseStoryArgs({ qr: true }) as never, tall.deps);
    expect(tall.output.join('\n')).not.toContain('Make this window taller');
  });

  it('shows no character-art preview in a terminal without images, and one inline image where it can', async () => {
    const rasterize = vi.fn(async () => ({ width: 2, height: 2, rgba: new Uint8Array(16), png: new Uint8Array(4) }));
    const apple = deps({ renderer: async () => ({ ...(await fakeRenderer()), rasterize }) });
    await runStory(parseStoryArgs({ 'no-qr': true }) as never, apple.deps);
    expect(rasterize).not.toHaveBeenCalled();
    expect(apple.output.join('\n')).not.toContain('▀');

    const iterm = deps({ env: { TERM_PROGRAM: 'iTerm.app' }, renderer: async () => ({ ...(await fakeRenderer()), rasterize }) });
    await runStory(parseStoryArgs({ 'no-qr': true }) as never, iterm.deps);
    expect(rasterize).toHaveBeenCalledOnce();
    expect(iterm.output.join('\n')).toContain('\x1b]1337;File=inline=1;');
  });

  it('asks before opening Finder, and only on macOS in a terminal', async () => {
    const reveal = vi.fn();
    const questions: string[] = [];
    const ask = vi.fn(async (question: string) => {
      questions.push(question);
      return question.includes('Finder');
    });
    const mac = deps({ platform: 'darwin', ask, reveal });
    await runStory(parseStoryArgs({}) as never, mac.deps);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain('phone');
    expect(questions[1]).toContain('Show them in Finder?');
    expect(reveal).toHaveBeenCalledOnce();

    reveal.mockClear();
    const no = deps({ platform: 'darwin', ask: async () => false, reveal });
    await runStory(parseStoryArgs({}) as never, no.deps);
    expect(reveal).not.toHaveBeenCalled();

    const linux = deps({ platform: 'linux', ask, reveal });
    questions.length = 0;
    await runStory(parseStoryArgs({}) as never, linux.deps);
    expect(questions).toHaveLength(1);
    expect(reveal).not.toHaveBeenCalled();

    const notty = deps({ platform: 'darwin', isTTY: false, ask, reveal });
    await runStory(parseStoryArgs({}) as never, notty.deps);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('shows a progress line per card in a terminal and only the final lines otherwise', async () => {
    const tty = deps();
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, tty.deps);
    const lines = tty.output.join('\n');
    expect(lines).toContain('Rendering Skyline…');
    expect(lines).toContain('\r\x1b[2K');
    expect(lines).toContain('✓ Skyline');

    const plain = deps({ isTTY: false });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, plain.deps);
    expect(plain.output.join('\n')).not.toContain('Rendering');
    expect(plain.output.join('\n')).not.toContain('\r');
    expect(plain.output.join('\n')).toContain('- Skyline');
  });

  it('says so when the range has no usage yet, and still renders the cards', async () => {
    const empty = deps({
      loadData: async (range, handle) => ({ ...demoStory(range, new Date('2026-10-11T12:00:00Z')), handle: handle ?? 'octocat', demo: false, total: 0 }),
    });
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, empty.deps);
    expect(empty.output.join('\n')).toContain('No usage in this range yet. Run `tokengraph sync` first, or try --range 30d.');
    expect(empty.written).toHaveLength(1);

    const full = deps();
    await runStory(parseStoryArgs({ 'no-qr': true, template: 'skyline' }) as never, full.deps);
    expect(full.output.join('\n')).not.toContain('No usage in this range');
  });

  it('prints "downloaded" for a saved card and nothing for a viewed one', async () => {
    let emit: (event: { kind: string; id?: string; userAgent?: string }) => void = () => undefined;
    const startShare = vi.fn(async (options: { onEvent?: typeof emit }) => {
      emit = options.onEvent!;
      return { url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('all-saved' as const), stop: () => undefined };
    });
    const { deps: d, output } = deps({ startShare: startShare as never });
    await runStory(parseStoryArgs({ qr: true }) as never, d);
    const before = output.length;
    emit({ kind: 'viewed', id: 'skyline' });
    expect(output).toHaveLength(before);
    emit({ kind: 'saved', id: 'skyline' });
    expect(output.slice(before).join('\n')).toContain('✓ Skyline downloaded');
    expect(output.join('\n')).not.toContain('saved to the phone');
  });
});
