import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, writeConfig } from '../src/config.js';
import { installKind, runUpdate, runUpdateSwitch, type UpdateDeps } from '../src/commands/update.js';

const NPM_BIN = '/opt/homebrew/lib/node_modules/tokengraph/bundle/bin.js';

describe('installKind', () => {
  it('recognises a global npm install by asking npm where its packages live', () => {
    expect(installKind(NPM_BIN, '/opt/homebrew/lib/node_modules')).toBe('npm');
    expect(installKind('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tokengraph\\bundle\\bin.js', 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules')).toBe('npm');
  });

  it('treats a package runner cache as npx', () => {
    expect(installKind('/Users/me/.npm/_npx/abc123/node_modules/tokengraph/bundle/bin.js', '/opt/homebrew/lib/node_modules')).toBe('npx');
  });

  it('leaves everything else alone: a project dependency, another package manager, a checkout, npm not found', () => {
    expect(installKind('/work/app/node_modules/tokengraph/bundle/bin.js', '/opt/homebrew/lib/node_modules')).toBe('other');
    expect(installKind('/Users/me/.bun/install/global/node_modules/tokengraph/bundle/bin.js', '/opt/homebrew/lib/node_modules')).toBe('other');
    expect(installKind('/Users/me/codes/tokengraph/cli/packages/cli/dist/bin.js', '/opt/homebrew/lib/node_modules')).toBe('other');
    expect(installKind(NPM_BIN, null)).toBe('other');
  });
});

describe('runUpdate', () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void err.push(args.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function deps(over: Partial<UpdateDeps> = {}) {
    let version = '0.1.1';
    const install = vi.fn(async () => ((version = '0.2.0'), 0));
    const confirm = vi.fn(async () => true);
    return {
      install,
      confirm,
      over: {
        currentVersion: () => version,
        latestVersion: async () => '0.2.0',
        kind: async () => 'npm' as const,
        interactive: true,
        install,
        confirm,
        ...over,
      } satisfies Partial<UpdateDeps>,
    };
  }

  it('says so when this is already the latest', async () => {
    const { install, confirm, over } = deps({ latestVersion: async () => '0.1.1' });
    expect(await runUpdate({ yes: false }, over)).toBe(0);
    expect(out.join('\n')).toContain('0.1.1 is the latest version');
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('asks first and shows the exact command it will run', async () => {
    const { install, confirm, over } = deps();
    expect(await runUpdate({ yes: false }, over)).toBe(0);
    expect(out.join('\n')).toContain('npm install -g tokengraph@0.2.0');
    expect(out.join('\n')).toContain('https://tokengraph.app/changelog/#v0.2.0');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith('0.2.0');
    expect(out.join('\n')).toContain('Updated tokengraph to 0.2.0');
  });

  it('installs nothing on no', async () => {
    const { install, over } = deps({ confirm: async () => false });
    expect(await runUpdate({ yes: false }, over)).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Not updated');
  });

  it('skips the question with --yes', async () => {
    const { install, confirm, over } = deps();
    expect(await runUpdate({ yes: true }, over)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('never installs from a script without --yes: it only reports', async () => {
    const { install, confirm, over } = deps({ interactive: false });
    expect(await runUpdate({ yes: false }, over)).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('tokengraph update --yes');
  });

  it('reports a failed install with the command to run by hand', async () => {
    const { over } = deps({ install: async () => 1 });
    expect(await runUpdate({ yes: true }, over)).toBe(1);
    expect(err.join('\n')).toContain('npm install -g tokengraph@0.2.0');
    expect(out.join('\n')).not.toContain('Updated tokengraph');
  });

  it('does not claim success when npm exits 0 but the installed version did not change', async () => {
    const { over } = deps({ install: async () => 0 });
    expect(await runUpdate({ yes: true }, over)).toBe(1);
    expect(err.join('\n')).toContain('still 0.1.1');
    expect(out.join('\n')).not.toContain('Updated tokengraph');
  });

  it('fails with a plain message when the registry cannot be reached', async () => {
    const { install, over } = deps({ latestVersion: async () => null });
    expect(await runUpdate({ yes: true }, over)).toBe(1);
    expect(err.join('\n')).toContain('Could not reach the npm registry');
    expect(install).not.toHaveBeenCalled();
  });

  it('tells an npx user how to get the new version instead of installing anything', async () => {
    const { install, over } = deps({ kind: async () => 'npx' });
    expect(await runUpdate({ yes: true }, over)).toBe(0);
    expect(out.join('\n')).toContain('npx tokengraph@latest');
    expect(install).not.toHaveBeenCalled();
  });

  it('never installs over a copy it does not manage', async () => {
    const { install, over } = deps({ kind: async () => 'other' });
    expect(await runUpdate({ yes: true }, over)).toBe(0);
    expect(out.join('\n')).toContain('the way you installed it');
    expect(install).not.toHaveBeenCalled();
  });
});

describe('runUpdateSwitch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns the daily check off and on and keeps the rest of the config', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await writeConfig({ machineId: '11111111-1111-4111-8111-111111111111' });
    expect(await runUpdateSwitch('off')).toBe(0);
    expect(await readConfig()).toEqual({ machineId: '11111111-1111-4111-8111-111111111111', update: { check: false } });
    expect(await runUpdateSwitch('on')).toBe(0);
    expect(await readConfig()).toEqual({ machineId: '11111111-1111-4111-8111-111111111111', update: { check: true } });
  });
});
