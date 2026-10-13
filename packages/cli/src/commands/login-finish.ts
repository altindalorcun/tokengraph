import { ephemeralInstallError } from '../bin-path.js';
import { askYesNo } from '../prompt.js';
import { runReadme } from './readme.js';
import { runSchedule } from './schedule.js';
import { runSync } from './sync.js';

export async function firstPublish(): Promise<number> {
  const code = await runSync({ sinceDays: 400, theme: 'light', trigger: 'manual', quiet: true });
  if (code !== 0) return code;
  return runReadme({ compact: false });
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
