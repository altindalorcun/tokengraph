import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { kiloDataDir } from '../src/adapters/kilo/index.js';
import { openCodeDataDir } from '../src/adapters/opencode/index.js';

describe('OpenCode and Kilo data dir', () => {
  const saved = process.env['XDG_DATA_HOME'];
  afterEach(() => {
    if (saved === undefined) delete process.env['XDG_DATA_HOME'];
    else process.env['XDG_DATA_HOME'] = saved;
  });

  it('uses XDG_DATA_HOME when it is set', () => {
    process.env['XDG_DATA_HOME'] = '/xdg/data';
    expect(openCodeDataDir()).toBe(join('/xdg/data', 'opencode'));
    expect(kiloDataDir()).toBe(join('/xdg/data', 'kilo'));
  });

  // The XDG spec, and the xdg-basedir package both tools use, treat an empty value as unset.
  it('falls back to ~/.local/share when XDG_DATA_HOME is unset or empty', () => {
    for (const value of [undefined, '']) {
      if (value === undefined) delete process.env['XDG_DATA_HOME'];
      else process.env['XDG_DATA_HOME'] = value;
      expect(openCodeDataDir()).toBe(join(homedir(), '.local', 'share', 'opencode'));
      expect(kiloDataDir()).toBe(join(homedir(), '.local', 'share', 'kilo'));
    }
  });
});
