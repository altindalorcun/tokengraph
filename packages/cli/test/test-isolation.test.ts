import { homedir, tmpdir } from 'node:os';
import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configHome } from '../src/paths.js';

const underTmp = (path: string | undefined): boolean => path !== undefined && path.startsWith(tmpdir() + sep);

describe('test isolation', () => {
  it('resolves the home directory and the config home under the temp dir', () => {
    expect(underTmp(homedir())).toBe(true);
    expect(underTmp(process.env['USERPROFILE'])).toBe(true);
    expect(underTmp(configHome())).toBe(true);
  });

  it('leaves no inherited agent or XDG folders pointing at the real home', () => {
    for (const name of [
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'GEMINI_CLI_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'APPDATA',
      'LOCALAPPDATA',
    ]) {
      const value = process.env[name];
      expect(value === undefined || underTmp(value), name).toBe(true);
    }
  });

  it('refuses to resolve the config home under vitest without TOKENGRAPH_HOME', () => {
    const saved = process.env['TOKENGRAPH_HOME'];
    delete process.env['TOKENGRAPH_HOME'];
    try {
      expect(() => configHome()).toThrow(/setup-home/);
    } finally {
      process.env['TOKENGRAPH_HOME'] = saved;
    }
  });
});
