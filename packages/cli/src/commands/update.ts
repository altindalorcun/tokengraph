import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { binPath, cliVersion, isEphemeralInstall } from '../bin-path.js';
import { readConfig, writeConfig } from '../config.js';
import { askYesNo } from '../prompt.js';
import { checkLatestNow, isNewerVersion } from '../update-check.js';

const CHANGELOG_URL = 'https://tokengraph.app/changelog/';
const NPM_ROOT_TIMEOUT_MS = 10_000;

export type InstallKind = 'npm' | 'npx' | 'other';

export interface UpdateDeps {
  /** Read from disk on every call, so after an install it reports what is really there. */
  currentVersion: () => string;
  latestVersion: () => Promise<string | null>;
  kind: () => Promise<InstallKind>;
  install: (version: string) => Promise<number>;
  confirm: (question: string) => Promise<boolean>;
  interactive: boolean;
}

function comparable(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * How this copy was installed. Only a copy inside npm's own global folder is `npm`: running `npm install -g` for a
 * project's dependency, a checkout or another package manager's copy would add a second tokengraph and update neither.
 */
export function installKind(bin: string, npmGlobalRoot: string | null): InstallKind {
  if (isEphemeralInstall(bin)) return 'npx';
  if (npmGlobalRoot === null) return 'other';
  return comparable(bin).startsWith(`${comparable(npmGlobalRoot)}/tokengraph/`) ? 'npm' : 'other';
}

// npm is npm.cmd on Windows, and Node only starts a .cmd through a shell. What reaches it is fixed text plus a version
// that matched the release pattern in update-check.ts.
function spawnNpm(args: readonly string[], stdio: StdioOptions): ChildProcess {
  if (process.platform === 'win32') return spawn(`npm ${args.join(' ')}`, { shell: true, stdio, windowsHide: true });
  return spawn('npm', args, { stdio });
}

function npmGlobalRoot(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnNpm(['root', '-g'], ['ignore', 'pipe', 'ignore']);
    const timer = setTimeout(() => child.kill(), NPM_ROOT_TIMEOUT_MS);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      const root = out.trim();
      if (code !== 0 || root === '') return resolve(null);
      // Compared with the entry script's path, which Node has already resolved through any symlink.
      realpath(root).then(resolve, () => resolve(root));
    });
  });
}

function installWithNpm(version: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnNpm(['install', '-g', `tokengraph@${version}`], 'inherit');
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const DEFAULT_DEPS: UpdateDeps = {
  currentVersion: cliVersion,
  latestVersion: () => checkLatestNow(),
  kind: async () => installKind(binPath(), await npmGlobalRoot()),
  install: installWithNpm,
  confirm: (question) => askYesNo(question),
  get interactive() {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  },
};

/** `tokengraph update`: always asks npm now, installs only a copy npm manages, and only after a yes. */
export async function runUpdate(options: { yes: boolean }, overrides: Partial<UpdateDeps> = {}): Promise<number> {
  const deps: UpdateDeps = { ...DEFAULT_DEPS, ...overrides };
  const current = deps.currentVersion();
  const latest = await deps.latestVersion();
  if (latest === null) {
    console.error('Could not reach the npm registry. Check your connection and try again.');
    return 1;
  }
  if (!isNewerVersion(latest, current)) {
    console.log(`tokengraph ${current} is the latest version.`);
    return 0;
  }

  console.log(`tokengraph ${latest} is available (you have ${current}).`);
  console.log(`What's new: ${CHANGELOG_URL}#v${latest}`);
  const kind = await deps.kind();
  if (kind === 'npx') {
    console.log('This copy runs through npx, so there is nothing to install. Start the new version with:');
    console.log('  npx tokengraph@latest');
    return 0;
  }
  if (kind === 'other') {
    console.log('This copy was not installed globally with npm. Update it the way you installed it, for example:');
    console.log('  npm install -g tokengraph@latest');
    return 0;
  }

  const command = `npm install -g tokengraph@${latest}`;
  console.log(`This runs: ${command}`);
  if (!options.yes) {
    if (!deps.interactive) {
      console.log('Run `tokengraph update --yes` to install it.');
      return 0;
    }
    if (!(await deps.confirm('Update now?'))) {
      console.log('Not updated.');
      return 0;
    }
  }
  if ((await deps.install(latest)) !== 0) {
    console.error(`npm did not finish. If it was a permissions error, run it yourself: ${command}`);
    return 1;
  }
  const installed = deps.currentVersion();
  if (installed !== latest) {
    console.error(`npm finished, but this copy is still ${installed}. Run it yourself: ${command}`);
    return 1;
  }
  console.log(`Updated tokengraph to ${latest}.`);
  return 0;
}

/** `tokengraph update on|off`: the daily check. `tokengraph update` itself keeps working when it is off. */
export async function runUpdateSwitch(action: 'on' | 'off'): Promise<number> {
  const config = await readConfig();
  await writeConfig({ ...config, update: { check: action === 'on' } });
  console.log(
    action === 'on'
      ? 'Update checks are on: the terminal view asks the npm registry for the latest version once a day.'
      : 'Update checks are off: tokengraph will not contact the npm registry until you run `tokengraph update`.',
  );
  return 0;
}
