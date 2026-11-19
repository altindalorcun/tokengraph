import { describe, expect, it } from 'vitest';
import { captureOutput, cleanPathInput } from '../../src/tui/run-action.js';

describe('captureOutput', () => {
  it('collects console output and restores the console', async () => {
    const log = console.log;
    const result = await captureOutput(async () => {
      console.log('one');
      console.info('two');
      console.warn('three');
      console.error('four', 4);
      return 0;
    });
    expect(result).toEqual({ code: 0, lines: ['one', 'two', 'three', 'four 4'] });
    expect(console.log).toBe(log);
  });

  it('turns a throw into code 1 with the message as the last line', async () => {
    const log = console.log;
    const result = await captureOutput(async () => {
      console.log('before');
      throw new Error('boom');
    });
    expect(result).toEqual({ code: 1, lines: ['before', 'boom'] });
    expect(console.log).toBe(log);
  });

  it('splits multi-line output into lines', async () => {
    const result = await captureOutput(async () => (console.log('a\nb'), 2));
    expect(result).toEqual({ code: 2, lines: ['a', 'b'] });
  });
});

describe('cleanPathInput', () => {
  it('takes a path as it is pasted or dropped into a terminal', () => {
    expect(cleanPathInput('  /tmp/usage.csv  ', '/home/me', 'darwin')).toBe('/tmp/usage.csv');
    expect(cleanPathInput("'/Users/me/My Files/usage.csv'", '/home/me', 'darwin')).toBe('/Users/me/My Files/usage.csv');
    expect(cleanPathInput('"/tmp/a b.csv"', '/home/me', 'linux')).toBe('/tmp/a b.csv');
    expect(cleanPathInput('/Users/me/My\\ Files/usage\\ (1).csv', '/home/me', 'darwin')).toBe('/Users/me/My Files/usage (1).csv');
    expect(cleanPathInput('~/Downloads/usage.csv', '/home/me', 'linux')).toBe('/home/me/Downloads/usage.csv');
    expect(cleanPathInput('C:\\Users\\me\\usage.csv', 'C:\\Users\\me', 'win32')).toBe('C:\\Users\\me\\usage.csv');
  });
});

describe('the Codex hook action', () => {
  it('shows the steps again, and keeps the hook, while Codex has not trusted it', async () => {
    const { mkdir, mkdtemp, readFile, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runAction } = await import('../../src/tui/run-action.js');
    const { codexHookCommand } = await import('../../src/codex-hooks.js');
    const saved = { CODEX_HOME: process.env['CODEX_HOME'], PATH: process.env['PATH'] };
    const codexHome = join(await mkdtemp(join(tmpdir(), 'codex-action-')), '.codex');
    process.env['CODEX_HOME'] = codexHome;
    process.env['PATH'] = ''; // no `codex` to ask for its version: the steps for a current Codex
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'config.toml'), 'notify = ["/usr/bin/true", "turn-ended"]\n');
      const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: codexHookCommand(), timeout: 30, statusMessage: 'tokengraph: sync usage' }] }] } };
      await writeFile(join(codexHome, 'hooks.json'), JSON.stringify(hooks));
      const status = {
        login: null,
        autoSync: {
          claudeHook: false, cursorHook: false, geminiHook: false, schedule: false, codexNotify: true,
          codex: { via: 'hook' as const, approval: 'pending' as const, notifyTaken: true, blocked: null, commands: [] },
        },
        cursorFetch: null,
        graphColors: 'model' as const,
        update: null,
      };
      const result = await runAction('hook:codex', status);
      expect(result.code).toBe(0);
      expect(result.lines[0]).toBe('The tokengraph Codex hook is installed. One step is left, in Codex.');
      expect(result.lines.join('\n')).toContain('Hooks need review');
      expect(JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'))).toEqual(hooks);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
