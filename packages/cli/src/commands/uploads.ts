import { readConfig, resolveApiUrl, writeConfig } from '../config.js';
import { uploadModeLine } from '../upload-mode.js';

/** `tokengraph uploads [on|off]`: shows or sets whether sync may upload from this machine. */
export async function runUploads(arg: string | undefined): Promise<number> {
  const config = await readConfig();
  if (arg === undefined) {
    console.log(uploadModeLine(config, resolveApiUrl(config)));
    return 0;
  }
  if (arg !== 'on' && arg !== 'off') {
    console.error('Usage: tokengraph uploads [on|off] — expected on or off.');
    return 1;
  }
  const next = { ...config, uploads: arg === 'on' };
  await writeConfig(next);
  console.log(uploadModeLine(next, resolveApiUrl(next)));
  return 0;
}
