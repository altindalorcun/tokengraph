import { describe, expect, it } from 'vitest';
import { clipboardCommands, copyToClipboard } from '../src/clipboard.js';

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
