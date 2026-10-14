import { ephemeralInstallError } from '../bin-path.js';
import { askYesNo } from '../prompt.js';
import { PROJECT_URL } from '../readme-snippet.js';
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

export async function offerSchedule(): Promise<void> {
  const blocked = ephemeralInstallError('tokengraph schedule');
  if (blocked) {
    console.log('\nTo keep the graph updated every hour, install tokengraph and turn on the schedule:');
    console.log('  npm install -g tokengraph && tokengraph schedule');
    return;
  }
  if (await askYesNo('\nKeep your graph updated every hour?')) await runSchedule({ remove: false, dryRun: false });
}
