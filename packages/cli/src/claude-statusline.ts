import { ephemeralInstallError, binPath } from './bin-path.js';
import { isTokenGraphStatuslineCommand } from './commands/statusline.js';
import { readSettings, settingsPath as claudeSettingsPath, statuslineCommand, writeJsonFile } from './commands/install-hook.js';
import { readConfig, writeConfig } from './config.js';
import type { Settings } from './hook-settings.js';
import { configPath as tokengraphConfigPath } from './paths.js';

/**
 * `tokengraph limits on|off`: wraps Claude Code's `statusLine` so `tokengraph statusline` sees the limit readings
 * Claude Code passes it (docs/adr/0001-claude-limits-via-statusline.md). `statusLine` holds one command, so the
 * user's own one is kept whole in `config.json` and written back exactly; a status line that is not ours is never
 * dropped, and ours is never stored as the previous one (it would call itself).
 */

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

function ourCommand(statusLine: unknown): boolean {
  return isObject(statusLine) && typeof statusLine['command'] === 'string' && isTokenGraphStatuslineCommand(statusLine['command']);
}

export function statuslineInstalled(settings: Settings): boolean {
  return ourCommand(settings['statusLine']);
}

export type StatuslineInstall = { settings: Settings; previous: Record<string, unknown> | null } | { refusal: string };

export function installStatusline(settings: Settings, ours: string, storedPrevious: Record<string, unknown> | null): StatuslineInstall {
  const current = settings['statusLine'];
  if (current === undefined) return { settings: { ...settings, statusLine: { type: 'command', command: ours } }, previous: null };
  if (ourCommand(current)) return { settings, previous: storedPrevious };
  if (!isObject(current) || typeof current['command'] !== 'string') {
    return { refusal: "Claude Code's statusLine setting is not a command tokengraph can wrap, so it was left as it is." };
  }
  return { settings: { ...settings, statusLine: { ...current, type: 'command', command: ours } }, previous: current };
}

export type StatuslineRemoval = { settings: Settings } | { untouched: 'not-ours' | 'absent' };

export function removeStatusline(settings: Settings, previous: Record<string, unknown> | null): StatuslineRemoval {
  const current = settings['statusLine'];
  if (current === undefined) return { untouched: 'absent' };
  if (!ourCommand(current)) return { untouched: 'not-ours' };
  if (previous) return { settings: { ...settings, statusLine: previous } };
  const { statusLine: _ours, ...rest } = settings;
  return { settings: rest };
}

export interface ClaudeLimitsOptions {
  settingsPath?: string;
  configPath?: string;
  /** This copy's script, which the status line command points at. */
  bin?: string;
  command?: string;
  dryRun?: boolean;
}

/** Turns the wrapper on or off. Never throws on a file it cannot use: the message says what happened. */
export async function setClaudeLimits(on: boolean, options: ClaudeLimitsOptions = {}): Promise<{ message: string; code: number }> {
  const settingsFile = options.settingsPath ?? claudeSettingsPath();
  const configFile = options.configPath ?? tokengraphConfigPath();
  const bin = options.bin ?? binPath();
  const dry = options.dryRun === true;

  if (on) {
    const ephemeral = ephemeralInstallError('tokengraph limits on', bin);
    if (ephemeral) return { message: ephemeral, code: 1 };
  }

  let settings: Settings;
  try {
    settings = await readSettings(settingsFile);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { message: `Could not read ${settingsFile}: ${reason}. Nothing was changed.`, code: 1 };
  }
  const config = await readConfig(configFile);

  if (on) {
    const result = installStatusline(settings, options.command ?? statuslineCommand(bin), config.claudeStatusline?.previous ?? null);
    if ('refusal' in result) return { message: result.refusal, code: 1 };
    if (result.settings === settings) return { message: 'Claude Code limits are already on.', code: 0 };
    const kept = result.previous && typeof result.previous['command'] === 'string' ? result.previous['command'] : null;
    const verb = dry ? 'Would wrap' : 'Wrapped';
    const message = `${verb} Claude Code's status line in ${settingsFile} to read its plan limits.${kept ? ` Your own status line (${kept}) keeps showing.` : ''}`;
    if (dry) return { message, code: 0 };
    // Config first: if the settings write fails, the old status line is still on record.
    await writeConfig({ ...config, claudeStatusline: { previous: result.previous } }, configFile);
    await writeJsonFile(settingsFile, result.settings);
    return { message, code: 0 };
  }

  const result = removeStatusline(settings, config.claudeStatusline?.previous ?? null);
  const forget = async () => {
    if (dry || !config.claudeStatusline) return;
    const { claudeStatusline: _done, ...rest } = config;
    await writeConfig(rest, configFile);
  };
  if ('untouched' in result) {
    await forget();
    return result.untouched === 'absent' || !config.claudeStatusline
      ? { message: 'The Claude Code status line wrapper is not installed.', code: 0 }
      : { message: "Claude Code's status line is no longer tokengraph's, so it was left as it is.", code: 0 };
  }
  if (dry) return { message: `Would put Claude Code's status line back in ${settingsFile}.`, code: 0 };
  await writeJsonFile(settingsFile, result.settings);
  await forget();
  return { message: `Put Claude Code's status line back in ${settingsFile}.`, code: 0 };
}
