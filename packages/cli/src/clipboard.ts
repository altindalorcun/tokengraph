import { spawn } from 'node:child_process';

export interface ClipboardDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Runs a command with `input` on stdin; true when it exits 0. */
  run: (command: string, args: string[], input: string) => Promise<boolean>;
}

export function clipboardCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): [string, string[]][] {
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  const x11: [string, string[]][] = [
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
  return env['WAYLAND_DISPLAY'] ? [['wl-copy', []], ...x11] : x11;
}

function runWithInput(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 2000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.stdin.end(input);
    } catch {
      resolve(false);
    }
  });
}

/** Best effort: the text is always printed too, so a machine without a clipboard tool loses nothing. */
export async function copyToClipboard(text: string, deps: Partial<ClipboardDeps> = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runWithInput;
  for (const [command, args] of clipboardCommands(platform, env)) {
    if (await run(command, args, text)) return true;
  }
  return false;
}
