import { readConfig, writeConfig } from '../config.js';

export async function runLogout(): Promise<number> {
  const config = await readConfig();
  if (!config.github) {
    console.log('Not logged in.');
    return 0;
  }
  const { github, gists, ...rest } = config;
  // The machine id stays: logging in again must continue this machine, never count it twice.
  await writeConfig(rest);
  console.log(`Logged out @${github.login} on this machine. Syncs stay local until you log in again.`);
  if (gists?.graph || gists?.data) console.log(`Your gists stay on GitHub: https://gist.github.com/${github.login}`);
  if (github.auth.kind === 'token') console.log("To revoke tokengraph's access: https://github.com/settings/applications");
  return 0;
}
