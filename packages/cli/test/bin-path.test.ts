import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { binPath, cliVersion, ephemeralInstallError, isEphemeralInstall } from '../src/bin-path.js';

describe('binPath', () => {
  it('points at bin.js next to the module', () => {
    expect(binPath().replace(/\\/g, '/')).toMatch(/\/packages\/cli\/src\/bin\.js$/);
  });
});

describe('cliVersion', () => {
  it('reads the package version', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(cliVersion()).toBe(manifest.version);
  });
});

describe('isEphemeralInstall', () => {
  it('recognises package runner caches', () => {
    expect(isEphemeralInstall('/Users/me/.npm/_npx/0a1b2c/node_modules/tokengraph/bundle/bin.js')).toBe(true);
    expect(isEphemeralInstall('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\tokengraph\\bundle\\bin.js')).toBe(true);
    expect(isEphemeralInstall('/Users/me/Library/Caches/pnpm/dlx/abc/node_modules/tokengraph/bundle/bin.js')).toBe(true);
    expect(isEphemeralInstall('/tmp/xfs-1/dlx-123/node_modules/tokengraph/bundle/bin.js')).toBe(true);
    expect(isEphemeralInstall('/tmp/bunx-501-tokengraph@latest/node_modules/tokengraph/bundle/bin.js')).toBe(true);
  });

  it('accepts lasting installs', () => {
    expect(isEphemeralInstall('/usr/local/lib/node_modules/tokengraph/bundle/bin.js')).toBe(false);
    expect(isEphemeralInstall('/Users/me/.nvm/versions/node/v22.12.0/lib/node_modules/tokengraph/bundle/bin.js')).toBe(false);
    expect(isEphemeralInstall('/Users/me/codes/token-graph/packages/cli/dist/bin.js')).toBe(false);
  });
});

describe('ephemeralInstallError', () => {
  it('tells the user to install globally and how to retry', () => {
    const message = ephemeralInstallError('tokengraph schedule', '/Users/me/.npm/_npx/0a1b/node_modules/tokengraph/bundle/bin.js');
    expect(message).toContain('npm install -g tokengraph');
    expect(message).toContain('tokengraph schedule');
  });

  it('is null for a lasting install', () => {
    expect(ephemeralInstallError('tokengraph schedule', '/usr/local/lib/node_modules/tokengraph/bundle/bin.js')).toBeNull();
  });
});
