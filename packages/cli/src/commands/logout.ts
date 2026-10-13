import { readConfig, writeConfig } from '../config.js';

export async function runLogout(): Promise<number> {
  const config = await readConfig();
  if (!config.github) {
    console.log('Not logged in.');
    return 0;
  }
  const { github: _github, gists: _gists, ...rest } = config;
  await writeConfig(rest);
  console.log('Logged out.');
  return 0;
}
