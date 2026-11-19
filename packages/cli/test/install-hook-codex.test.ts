import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexConfigPath, codexNotifyArgs } from '../src/codex-config-toml.js';
import { codexHookCommand, codexHooksPath, codexTrustSteps } from '../src/codex-hooks.js';
import { runInstallHook } from '../src/commands/install-hook.js';

describe('install-hook --agent codex', () => {
  const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], CODEX_HOME: process.env['CODEX_HOME'] };
  let home: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  const restore = (key: keyof typeof saved) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    process.env['CODEX_HOME'] = join(home, '.codex');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restore('HOME');
    restore('USERPROFILE');
    restore('CODEX_HOME');
    vi.restoreAllMocks();
  });

  const options = (overrides = {}) => ({ agent: 'codex' as const, event: 'SessionEnd', remove: false, dryRun: false, ...overrides });
  const output = () => log.mock.calls.map((call) => call.join(' ')).join('\n');
  const ours = () => `notify = [${codexNotifyArgs().map((a) => JSON.stringify(a)).join(', ')}]`;

  it('resolves config.toml under CODEX_HOME and runs hook-sync with a 10 minute floor', () => {
    expect(codexConfigPath()).toBe(join(home, '.codex', 'config.toml'));
    expect(codexNotifyArgs().slice(2)).toEqual(['hook-sync', '--min-interval', '600']);
    delete process.env['CODEX_HOME'];
    expect(codexConfigPath()).toBe(join(home, '.codex', 'config.toml'));
  });

  it('creates config.toml with our notify when there is none', async () => {
    expect(await runInstallHook(options())).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(`${ours()}\n`);
    expect(output()).toContain('Installed the tokengraph Codex hook (notify).');
    expect(output()).toContain(`config: ${codexConfigPath()}`);
  });

  it('writes our notify above the existing content and backs the file up', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    const existing = 'model = "o3"\n\n[profiles.work]\nnotify = ["say"]\n';
    await writeFile(codexConfigPath(), existing);
    expect(await runInstallHook(options())).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(`${ours()}\n${existing}`);
    expect(await readFile(`${codexConfigPath()}.tokengraph.bak`, 'utf8')).toBe(existing);
  });

  it('is a no-op the second time', async () => {
    await runInstallHook(options());
    log.mockClear();
    expect(await runInstallHook(options())).toBe(0);
    expect(output()).toContain('already installed');
  });

  it('does not write on a dry run', async () => {
    expect(await runInstallHook(options({ dryRun: true }))).toBe(0);
    await expect(readFile(codexConfigPath(), 'utf8')).rejects.toThrow();
    expect(output()).toContain(ours());
  });

  it('removes our notify and leaves the rest', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(codexConfigPath(), 'model = "o3"\n');
    await runInstallHook(options());
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe('model = "o3"\n');
  });

  it('does not remove a foreign notify', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    const existing = 'notify = ["say"]\n';
    await writeFile(codexConfigPath(), existing);
    expect(await runInstallHook(options({ remove: true }))).toBe(0);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(existing);
  });

  describe('when another program holds notify', () => {
    const COMPUTER_USE =
      'notify = ["/Users/me/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient", "turn-ended"]\n';
    const config = `model = "gpt-5"\n${COMPUTER_USE}\n[projects."/x"]\ntrust_level = "trusted"\n`;
    const modern = { codexVersion: async () => 'codex-cli 0.155.1\n', readRequirements: async () => null };
    const errors = () => err.mock.calls.map((call) => call.join(' ')).join('\n');
    const ourHook = () => ({ type: 'command', command: codexHookCommand(), timeout: 30, statusMessage: 'tokengraph: sync usage' });

    beforeEach(async () => {
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(codexConfigPath(), config);
    });

    it('adds a Stop hook to hooks.json, leaves config.toml alone and prints the steps to trust it', async () => {
      expect(await runInstallHook(options(), modern)).toBe(0);
      expect(await readFile(codexConfigPath(), 'utf8')).toBe(config);
      expect(JSON.parse(await readFile(codexHooksPath(), 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [ourHook()] }] } });
      expect(codexHooksPath()).toBe(join(home, '.codex', 'hooks.json'));
      const lines = output().split('\n');
      expect(lines[0]).toBe('Installed the tokengraph Codex hook. One step is left, in Codex.');
      expect(lines.slice(2, 2 + codexTrustSteps('0.155.1').length)).toEqual(codexTrustSteps('0.155.1'));
      expect(output()).toContain('SkyComputerUseClient');
      expect(output()).toContain('press 2 ("Trust all and continue"), then Enter');
    });

    it('keeps foreign hooks, backs the file up, and is a no-op the second time', async () => {
      const foreign = { description: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/stop.py' }] }] } };
      const original = `${JSON.stringify(foreign, null, 2)}\n`;
      await writeFile(codexHooksPath(), original);
      expect(await runInstallHook(options(), modern)).toBe(0);
      expect(JSON.parse(await readFile(codexHooksPath(), 'utf8'))).toEqual({ ...foreign, hooks: { Stop: [...foreign.hooks.Stop, { hooks: [ourHook()] }] } });
      expect(await readFile(`${codexHooksPath()}.tokengraph.bak`, 'utf8')).toBe(original);
      log.mockClear();
      expect(await runInstallHook(options(), modern)).toBe(0);
      expect(output()).toContain('The tokengraph Codex hook is installed. One step is left, in Codex.');
      expect(output()).toContain('1. Quit Codex and open it again.');
      expect(output()).not.toContain('already installed');
    });

    it('says it is done once Codex trusts it, and how to turn it back on when it is off', async () => {
      await runInstallHook(options(), modern);
      await writeFile(codexConfigPath(), `${config}\n[hooks.state."${codexHooksPath()}:stop:0:0"]\ntrusted_hash = "sha256:ab"\n`);
      log.mockClear();
      expect(await runInstallHook(options(), modern)).toBe(0);
      expect(output()).toBe('The tokengraph Codex hook is already installed (Stop), and Codex trusts it.');
      await writeFile(codexConfigPath(), `${config}\n[hooks.state."${codexHooksPath()}:stop:0:0"]\nenabled = false\ntrusted_hash = "sha256:ab"\n`);
      log.mockClear();
      expect(await runInstallHook(options(), modern)).toBe(0);
      expect(output()).toContain('turned off in Codex');
      expect(output()).toContain('then Space (turn it on)');
    });

    it('words the steps for the Codex it finds', async () => {
      expect(await runInstallHook(options(), { ...modern, codexVersion: async () => 'codex-cli 0.126.0' })).toBe(0);
      expect(output()).toContain('without asking you to trust them');
      expect(output()).not.toContain('Hooks need review');
    });

    it('refreshes an older command in place', async () => {
      const old = '"/old/node" "/old/lib/node_modules/tokengraph/bundle/bin.js" hook-sync --min-interval 600';
      await writeFile(codexHooksPath(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: old, timeout: 30 }] }, { hooks: [{ type: 'command', command: 'say hi' }] }] } }));
      expect(await runInstallHook(options(), modern)).toBe(0);
      const file = JSON.parse(await readFile(codexHooksPath(), 'utf8'));
      expect(file.hooks.Stop[0].hooks[0]).toEqual(ourHook());
      expect(file.hooks.Stop[1].hooks[0].command).toBe('say hi');
      expect(output().split('\n')[0]).toBe('Updated the tokengraph Codex hook. One step is left, in Codex.');
    });

    it('refuses without writing when Codex is too old for hooks', async () => {
      expect(await runInstallHook(options(), { ...modern, codexVersion: async () => 'codex-cli 0.120.0' })).toBe(1);
      await expect(stat(codexHooksPath())).rejects.toThrow();
      expect(await readFile(codexConfigPath(), 'utf8')).toBe(config);
      expect(errors()).toContain('Codex 0.120.0 is older than 0.124.0');
      expect(errors()).toContain('tokengraph schedule');
      const last = errors().split('\n').at(-1)!;
      expect(last).toBe('Codex: use the hourly sync instead.');
    });

    it('refuses without writing when hooks are turned off, in config.toml or by the administrator', async () => {
      await writeFile(codexConfigPath(), `${config}\n[features]\nhooks = false\n`);
      expect(await runInstallHook(options(), modern)).toBe(1);
      await expect(stat(codexHooksPath())).rejects.toThrow();
      expect(errors()).toContain('turned off in its config.toml');
      await writeFile(codexConfigPath(), config);
      expect(await runInstallHook(options(), { ...modern, readRequirements: async () => 'allow_managed_hooks_only = true\n' })).toBe(1);
      await expect(stat(codexHooksPath())).rejects.toThrow();
    });

    it('installs when the version cannot be checked, and says which version it needs', async () => {
      expect(await runInstallHook(options(), { ...modern, codexVersion: async () => null })).toBe(0);
      expect(output()).toContain('need Codex 0.124.0 or newer');
    });

    it('refuses an invalid hooks.json without writing', async () => {
      await writeFile(codexHooksPath(), '{ "hooks": { // comment\n} }');
      expect(await runInstallHook(options(), modern)).toBe(1);
      expect(await readFile(codexHooksPath(), 'utf8')).toBe('{ "hooks": { // comment\n} }');
      await expect(stat(`${codexHooksPath()}.tokengraph.bak`)).rejects.toThrow();
      expect(errors()).toContain('not valid JSON');
      await writeFile(codexHooksPath(), '{ "hooks": [] }');
      expect(await runInstallHook(options(), modern)).toBe(1);
      expect(await readFile(codexHooksPath(), 'utf8')).toBe('{ "hooks": [] }');
    });

    it('shows the hook on a dry run without writing', async () => {
      expect(await runInstallHook(options({ dryRun: true }), modern)).toBe(0);
      await expect(stat(codexHooksPath())).rejects.toThrow();
      expect(output()).toContain(JSON.stringify(codexHookCommand()));
    });

    it('--remove takes out only our hook and deletes a file that held nothing else', async () => {
      await runInstallHook(options(), modern);
      log.mockClear();
      expect(await runInstallHook(options({ remove: true }), modern)).toBe(0);
      await expect(stat(codexHooksPath())).rejects.toThrow();
      expect(await readFile(codexConfigPath(), 'utf8')).toBe(config);
      expect(output()).toContain('Removed the tokengraph Codex hook (Stop).');

      // Approved in Codex: the approval goes too, and config.toml is as it was.
      await runInstallHook(options(), modern);
      await writeFile(codexConfigPath(), `${config}\n[hooks.state]\n\n[hooks.state."${codexHooksPath()}:stop:0:0"]\ntrusted_hash = "sha256:ab"\n`);
      expect(await runInstallHook(options({ remove: true }), modern)).toBe(0);
      expect(await readFile(codexConfigPath(), 'utf8')).toBe(config);
      await expect(stat(codexHooksPath())).rejects.toThrow();

      const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/stop.py' }] }] } };
      await writeFile(codexHooksPath(), JSON.stringify(foreign));
      await runInstallHook(options(), modern);
      expect(await runInstallHook(options({ remove: true }), modern)).toBe(0);
      expect(JSON.parse(await readFile(codexHooksPath(), 'utf8'))).toEqual(foreign);
    });

    it('keeps using the hook once installed, even after notify frees up, and --remove clears both', async () => {
      await runInstallHook(options(), modern);
      await writeFile(codexConfigPath(), 'model = "gpt-5"\n');
      log.mockClear();
      expect(await runInstallHook(options(), modern)).toBe(0);
      expect(output()).toContain('The tokengraph Codex hook is installed.');
      expect(await readFile(codexConfigPath(), 'utf8')).toBe('model = "gpt-5"\n');
      // A notify of ours and a hook of ours (installed by hand or an older copy): both go.
      await writeFile(codexConfigPath(), `${ours()}\nmodel = "gpt-5"\n`);
      expect(await runInstallHook(options({ remove: true }), modern)).toBe(0);
      expect(await readFile(codexConfigPath(), 'utf8')).toBe('model = "gpt-5"\n');
      await expect(stat(codexHooksPath())).rejects.toThrow();
    });
  });
});
