import { describe, expect, it } from 'vitest';
import { clipboardCommands, copyToClipboard, runWithInput } from '../src/clipboard.js';

describe('clipboardCommands', () => {
  it('picks the platform tool', () => {
    expect(clipboardCommands('darwin', {})).toEqual([['pbcopy', []]]);
    expect(clipboardCommands('win32', {})).toEqual([['clip', []]]);
    expect(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' })[0]).toEqual(['wl-copy', []]);
    expect(clipboardCommands('linux', {}).map(([command]) => command)).toEqual(['xclip', 'xsel']);
  });
});

describe('copyToClipboard', () => {
  it('tries the next tool when one is missing', async () => {
    const tried: string[] = [];
    const ok = await copyToClipboard('hi', {
      platform: 'linux',
      env: {},
      run: async (command, _args, input) => {
        tried.push(`${command}:${input}`);
        return command === 'xsel';
      },
    });
    expect(ok).toBe(true);
    expect(tried).toEqual(['xclip:hi', 'xsel:hi']);
  });

  it('reports failure without throwing', async () => {
    expect(await copyToClipboard('hi', { platform: 'linux', env: {}, run: async () => false })).toBe(false);
  });
});

describe('runWithInput', () => {
  it('resolves false, without throwing, when the tool exits before reading stdin', async () => {
    const big = 'x'.repeat(5_000_000);
    expect(await runWithInput(process.execPath, ['-e', 'process.exit(1)'], big)).toBe(false);
  });

  it('resolves false for a missing tool', async () => {
    expect(await runWithInput('tokengraph-no-such-tool', [], 'hi')).toBe(false);
  });
});
