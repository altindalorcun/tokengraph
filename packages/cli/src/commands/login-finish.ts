import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { binPath, cliVersion, isEphemeralInstall } from '../bin-path.js';
import { globalBinPath, installGlobally, npmGlobalRoot } from '../npm-global.js';
import { askYesNo } from '../prompt.js';
import { PROJECT_URL } from '../readme-snippet.js';
import { isReleaseVersion } from '../update-check.js';
import { runReadme } from './readme.js';
import { runSchedule } from './schedule.js';
import { runSync, SYNC_NO_AGENTS, SYNC_SKIPPED, type SyncOptions } from './sync.js';

export interface FirstPublishDeps {
  sync: (options: SyncOptions) => Promise<number>;
  readme: () => Promise<number>;
}

export async function firstPublish(
  deps: FirstPublishDeps = { sync: runSync, readme: () => runReadme({ compact: false }) },
): Promise<number> {
  console.log('Publishing your graph…');
  const code = await deps.sync({ sinceDays: 400, theme: 'light', trigger: 'manual', quiet: true, detailedExit: true });
  // Neither of these is a failed login: the graph simply comes later.
  if (code === SYNC_SKIPPED) {
    console.log('Another sync is running; your graph will be published when it finishes. Run `tokengraph readme` afterwards.');
    return 0;
  }
  if (code === SYNC_NO_AGENTS) {
    console.log('No agent usage found yet — your graph will appear after your first session.');
    return 0;
  }
  if (code !== 0) return code;
  const readmeCode = await deps.readme();
  if (readmeCode === 0) console.log(`\nIf you like it, a ⭐ on GitHub helps other people find it: ${PROJECT_URL}`);
  return readmeCode;
}

/** The command a person runs by hand when tokengraph cannot install itself. */
export const INSTALL_AND_SCHEDULE = 'npm install -g tokengraph && tokengraph schedule';
const EACCES_HELP = 'https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally';

export interface OfferScheduleDeps {
  /** True when this copy runs from a package runner's cache (npx), where a schedule cannot point. */
  ephemeral: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  /** The schedule from this copy, for a lasting install. */
  schedule: () => Promise<number>;
  version: () => string;
  install: (version: string) => Promise<number>;
  /** The entry script `npm install -g` just wrote, or null when it cannot be found. */
  installedBin: () => Promise<string | null>;
  /** Runs the installed copy with these arguments on this terminal and resolves with its exit code. */
  runInstalled: (bin: string, args: readonly string[]) => Promise<number>;
}

function runWithThisNode(bin: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit', windowsHide: true });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const DEFAULT_OFFER_DEPS: OfferScheduleDeps = {
  ephemeral: () => isEphemeralInstall(binPath()),
  confirm: (question) => askYesNo(question),
  schedule: () => runSchedule({ remove: false, dryRun: false }),
  version: cliVersion,
  install: installGlobally,
  installedBin: async () => {
    const root = await npmGlobalRoot();
    if (root === null) return null;
    const bin = globalBinPath(root);
    return existsSync(bin) ? bin : null;
  },
  runInstalled: runWithThisNode,
};

/**
 * After the first publish: offer the hourly sync. A lasting install turns it on directly. A copy run through npx
 * cannot, because the schedule stores this script's path and npm may clear its cache at any time, so it offers to
 * install tokengraph globally first and then turns the schedule on from that copy. Only called in a terminal.
 */
export async function offerSchedule(overrides: Partial<OfferScheduleDeps> = {}): Promise<void> {
  const deps: OfferScheduleDeps = { ...DEFAULT_OFFER_DEPS, ...overrides };
  if (!deps.ephemeral()) {
    if (await deps.confirm('\nKeep your graph updated every hour?')) await deps.schedule();
    return;
  }

  // The running version, so the installed copy behaves like the one just used; `latest` if it is not a plain release.
  const current = deps.version();
  const version = isReleaseVersion(current) ? current : 'latest';
  console.log('\nThis copy runs through npx, so it cannot update your graph on its own.');
  console.log(`Installing it once (npm install -g tokengraph@${version}) lets it sync every hour in the background.`);
  if (!(await deps.confirm('Install tokengraph and keep your graph updated every hour?'))) {
    console.log('Not installed. To do it later:');
    console.log(`  ${INSTALL_AND_SCHEDULE}`);
    return;
  }

  if ((await deps.install(version)) !== 0) {
    console.log('\nnpm could not install tokengraph. If it was a permissions error (EACCES), see:');
    console.log(`  ${EACCES_HELP}`);
    console.log('Then run:');
    console.log(`  ${INSTALL_AND_SCHEDULE}`);
    return;
  }
  const bin = await deps.installedBin();
  if (bin === null) {
    console.log('\nInstalled. Now turn on the hourly sync with: tokengraph schedule');
    return;
  }
  if ((await deps.runInstalled(bin, ['schedule'])) !== 0) {
    console.log('The hourly sync is not on yet. Run it yourself: tokengraph schedule');
  }
}
