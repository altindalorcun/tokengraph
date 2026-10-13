import type { CliConfig } from './config.js';

/** upload: logged in with uploads on. off: switched off by the user. local: never logged in. */
export type UploadMode = 'upload' | 'off' | 'local';

/** Whether sync may upload from this machine, and if not, why. */
export function uploadMode(config: CliConfig): UploadMode {
  if (config.uploads === false) return 'off';
  return config.apiKey && config.deviceId ? 'upload' : 'local';
}

/** One-line description of the current mode, with the command that changes it. */
export function uploadModeLine(config: CliConfig, apiUrl: string): string {
  switch (uploadMode(config)) {
    case 'upload':
      return `uploads: on — sync sends daily totals to ${apiUrl} as ${config.username ?? 'your account'}.`;
    case 'off':
      return 'uploads: off — sync only updates the local ledger. Turn on with `tokengraph uploads on`.';
    case 'local':
      return 'uploads: on, but this machine is not logged in — everything stays local. Run `tokengraph login` to publish your graph.';
  }
}
