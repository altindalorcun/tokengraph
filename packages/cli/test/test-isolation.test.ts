import { readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configHome } from '../src/paths.js';
import { CLEARED_ENV } from './isolated-env.js';

const underTmp = (path: string | undefined): boolean => path !== undefined && path.startsWith(tmpdir() + sep);

describe('test isolation', () => {
  it('resolves the home directory and the config home under the temp dir', () => {
    expect(underTmp(homedir())).toBe(true);
    expect(underTmp(process.env['USERPROFILE'])).toBe(true);
    expect(underTmp(configHome())).toBe(true);
  });

  it('ignores an inherited TOKENGRAPH_HOME: the setup file owns it', () => {
    expect(configHome()).toBe(join(homedir(), '.tokengraph'));
  });

  it('leaves no inherited agent or XDG folders pointing at the real home', () => {
    for (const name of CLEARED_ENV) {
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
      if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
      else process.env['TOKENGRAPH_HOME'] = saved;
    }
  });

  it('clears every environment variable the source reads to locate data', () => {
    // Not locators: HOME-like variables handled by setup-home.ts itself, the test flag, UI toggles, user names, the print width.
    const allowed = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TOKENGRAPH_HOME', 'VITEST', 'TOKENGRAPH_NO_MOTION', 'USER', 'USERNAME', 'COLUMNS']);
    const srcDir = join(__dirname, '..', 'src');
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) {
          // `process.env['NAME']`, `process.env.NAME`, the OpenCode family's `dbEnvVar: 'NAME'`, and the root
          // resolvers' injected environment: `envPath(ctx, 'NAME')`, `envText(ctx, 'NAME')`, `ctx.env['NAME']`.
          const text = readFileSync(path, 'utf8');
          for (const m of text.matchAll(/process\.env(?:\['([A-Z0-9_]+)'\]|\.([A-Z0-9_]+))|dbEnvVar:\s*'([A-Z0-9_]+)'|env(?:Path|Text)\(\s*ctx,\s*'([A-Z0-9_]+)'|ctx\.env\['([A-Z0-9_]+)'\]/g)) {
            names.add((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5])!);
          }
        }
      }
    };
    walk(srcDir);
    expect(names.size).toBeGreaterThan(10);
    const cleared = new Set<string>(CLEARED_ENV);
    expect([...names].filter((name) => !allowed.has(name) && !cleared.has(name))).toEqual([]);
  });
});
