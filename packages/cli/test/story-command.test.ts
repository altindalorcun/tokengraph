import { demoStory } from '@tokengraph/core';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { listenForKeys, parseStoryArgs, runStory, safeFileHandle, type StoryDeps } from '../src/commands/story.js';

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
    onKey: () => () => undefined,
    ...overrides,
  };
  return { deps: base, written, output };
}

describe('parseStoryArgs', () => {
  it('reads the defaults and validates values', () => {
    expect(parseStoryArgs({})).toEqual({ templates: ['skyline', 'receipt', 'sticker'], range: 'ask', showCost: true, qr: 'auto', save: false, preview: true });
    expect(parseStoryArgs({ template: 'receipt', range: '7d', 'no-cost': true, qr: true, 'no-preview': true, out: '/x', handle: 'me' })).toEqual({
      templates: ['receipt'], range: '7d', showCost: false, qr: 'yes', save: true, preview: false, outDir: '/x', handle: 'me',
    });
    expect(parseStoryArgs({ 'no-qr': true })).toMatchObject({ qr: 'no', save: true });
    expect(parseStoryArgs({ save: true })).toMatchObject({ qr: 'auto', save: true });
    expect(parseStoryArgs({ qr: true })).toMatchObject({ qr: 'yes', save: false });
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

  it('shows the QR code right away in a terminal and writes nothing to this computer', async () => {
    const startShare = vi.fn(async () => ({ url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('stopped' as const), stop: () => undefined }));
    const ask = vi.fn(async () => true);
    const { deps: d, output, written } = deps({ ask, startShare });
    expect(await runStory(parseStoryArgs({}) as never, d)).toBe(0);
    expect(startShare).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    const text = output.join('\n');
    expect(text).toContain('http://127.0.0.1:1/tok/');
    expect(text).not.toContain('Saved to');
  });

  it('saves the cards on this computer when S is pressed, once, and says where', async () => {
    let resolveDone: (reason: 'stopped') => void = () => undefined;
    const done = new Promise<'stopped'>((resolve) => {
      resolveDone = resolve;
    });
    let emit: (event: { kind: string; userAgent?: string }) => void = () => undefined;
    const startShare = vi.fn(async (options: { onEvent?: typeof emit }) => {
      emit = options.onEvent!;
      return { url: 'http://127.0.0.1:1/tok/', done, stop: () => resolveDone('stopped') };
    });
    let press: (key: string) => void = () => undefined;
    const releaseKeys = vi.fn();
    const { deps: d, output, written } = deps({
      startShare: startShare as never,
      onKey: (handler) => {
        press = handler;
        return releaseKeys;
      },
    });
    const finished = runStory(parseStoryArgs({}) as never, d);
    await vi.waitFor(() => expect(output.join('\n')).toContain('Ctrl+C'));
    expect(output.join('\n')).not.toContain('Press S');

    emit({ kind: 'page', userAgent: 'iPhone' });
    expect(output.join('\n')).toContain('Phone connected');
    expect(output.join('\n')).toContain('Press S to also save the cards on this computer.');
    emit({ kind: 'page', userAgent: 'iPhone' });
    expect(output.join('\n').match(/Press S/g)).toHaveLength(1);

    press('s');
    await vi.waitFor(() => expect(written).toHaveLength(3));
    press('S');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written).toEqual([
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-receipt.png',
      '/home/me/Downloads/tokengraph-octocat-2026-10-11-sticker.png',
    ]);
    expect(output.join('\n')).toContain('✓ Saved to /home/me/Downloads');

    press('\x03');
    expect(await finished).toBe(0);
    expect(releaseKeys).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('Stopped sharing.');
    expect(output.join('\n')).not.toContain('never opened');
  });

  it('keeps sharing when S cannot write the folder', async () => {
    let resolveDone: (reason: 'stopped') => void = () => undefined;
    const done = new Promise<'stopped'>((resolve) => {
      resolveDone = resolve;
    });
    let press: (key: string) => void = () => undefined;
    const { deps: d, output } = deps({
      startShare: async () => ({ url: 'http://127.0.0.1:1/tok/', done, stop: () => resolveDone('stopped') }),
      writeFile: async () => {
        throw new Error('EACCES: permission denied');
      },
      onKey: (handler) => {
        press = handler;
        return () => undefined;
      },
    });
    const finished = runStory(parseStoryArgs({}) as never, d);
    await vi.waitFor(() => expect(output.join('\n')).toContain('Ctrl+C'));
    press('s');
    await vi.waitFor(() => expect(output.join('\n')).toContain('EACCES'));
    press('q');
    expect(await finished).toBe(0);
  });

  it('with --save or --out saves first and still shows the QR code, without the S hint', async () => {
    let emit: (event: { kind: string; userAgent?: string }) => void = () => undefined;
    const startShare = vi.fn(async (options: { onEvent?: typeof emit }) => {
      emit = options.onEvent!;
      return { url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('all-saved' as const), stop: () => undefined };
    });
    const saved = deps({ startShare: startShare as never });
    expect(await runStory(parseStoryArgs({ save: true, template: 'skyline' }) as never, saved.deps)).toBe(0);
    expect(saved.written).toEqual(['/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png']);
    expect(startShare).toHaveBeenCalledOnce();
    emit({ kind: 'page', userAgent: 'Android' });
    expect(saved.output.join('\n')).not.toContain('Press S');

    const out = deps({ startShare: startShare as never });
    await runStory(parseStoryArgs({ out: '/tmp/cards', template: 'skyline' }) as never, out.deps);
    expect(out.written).toEqual(['/tmp/cards/tokengraph-octocat-2026-10-11-skyline.png']);
  });

  it('suggests --save when the phone never opened the page', async () => {
    const startShare = vi.fn(async () => ({ url: 'http://127.0.0.1:1/tok/', done: Promise.resolve('idle' as const), stop: () => undefined }));
    const { deps: d, output } = deps({ startShare });
    await runStory(parseStoryArgs({}) as never, d);
    expect(output.join('\n')).toContain('No activity for 10 minutes. Stopped sharing.');
    expect(output.join('\n')).toContain('tokengraph story --save');
  });

  it('without a network offers to save the cards here instead', async () => {
    const yes = deps({ lanAddress: () => null, ask: async (question) => question.includes('instead') });
    expect(await runStory(parseStoryArgs({ template: 'skyline' }) as never, yes.deps)).toBe(0);
    expect(yes.written).toEqual(['/home/me/Downloads/tokengraph-octocat-2026-10-11-skyline.png']);

    const no = deps({ lanAddress: () => null, ask: async () => false });
    expect(await runStory(parseStoryArgs({ template: 'skyline' }) as never, no.deps)).toBe(0);
    expect(no.written).toEqual([]);

    const ask = vi.fn(async () => true);
    const plain = deps({ isTTY: false, lanAddress: () => null, ask });
    expect(await runStory(parseStoryArgs({ qr: true, template: 'skyline' }) as never, plain.deps)).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    expect(plain.written).toEqual([]);
    expect(plain.output.join('\n')).toContain('tokengraph story --save');
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
    expect(output.join('\n')).toContain('AirDrop');
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
    await runStory(parseStoryArgs({ 'no-qr': true }) as never, mac.deps);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Show them in Finder?');
    expect(reveal).toHaveBeenCalledOnce();

    reveal.mockClear();
    const no = deps({ platform: 'darwin', ask: async () => false, reveal });
    await runStory(parseStoryArgs({ 'no-qr': true }) as never, no.deps);
    expect(reveal).not.toHaveBeenCalled();

    const linux = deps({ platform: 'linux', ask, reveal });
    questions.length = 0;
    await runStory(parseStoryArgs({ 'no-qr': true }) as never, linux.deps);
    expect(questions).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();

    const notty = deps({ platform: 'darwin', isTTY: false, ask, reveal });
    await runStory(parseStoryArgs({ 'no-qr': true }) as never, notty.deps);
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
    // The demo data's range is today; the hint names the next longer one.
    expect(empty.output.join('\n')).toContain("No usage in this range yet, so the cards show 0. Try --range 7d, or run `tokengraph sync` to read your agents' newest logs.");
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

describe('listenForKeys', () => {
  function fakeStdin(isTTY: boolean) {
    const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const modes: boolean[] = [];
    Object.assign(emitter, {
      isTTY,
      isRaw: false,
      setRawMode: (mode: boolean) => {
        modes.push(mode);
        return emitter;
      },
      resume: vi.fn(),
      pause: vi.fn(),
    });
    return { stdin: emitter as never, modes, emitter };
  }

  it('reads each key in raw mode and puts the terminal back once', () => {
    const { stdin, modes, emitter } = fakeStdin(true);
    const keys: string[] = [];
    const release = listenForKeys(stdin, (key) => keys.push(key));
    emitter.emit('data', Buffer.from('s\x03'));
    release();
    release();
    emitter.emit('data', 'q');
    expect(keys).toEqual(['s', '\x03']);
    expect(modes).toEqual([true, false]);
    expect(emitter.listenerCount('data')).toBe(0);
  });

  it('does nothing without a terminal', () => {
    const { stdin, modes } = fakeStdin(false);
    listenForKeys(stdin, () => undefined)();
    expect(modes).toEqual([]);
  });
});
