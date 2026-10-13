import { readConfig, resolveApiUrl, writeConfig } from '../config.js';

export async function runLogout(): Promise<number> {
  const config = await readConfig();
  if (!config.apiKey) {
    console.log('Not logged in.');
    return 0;
  }
  // The device ID is kept so logging back in reuses it instead of double-counting this machine.
  const { apiKey: _apiKey, username: _username, ...rest } = config;
  await writeConfig(rest);
  console.log('Logged out on this machine.');
  console.log(`The API key stays valid until you revoke it at ${resolveApiUrl(config)}/settings.`);
  return 0;
}
