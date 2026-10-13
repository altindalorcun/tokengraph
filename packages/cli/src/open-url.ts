import { spawn } from 'node:child_process';

function launch(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL or path is printed as well, so a missing opener is not a failure.
  }
}

export function openUrl(url: string): void {
  if (process.platform === 'darwin') launch('open', [url]);
  else if (process.platform === 'win32') launch('cmd', ['/c', 'start', '', url]);
  else launch('xdg-open', [url]);
}

/** Shows a saved file in Finder / Explorer, selected; on Linux opens its folder. */
export function revealInFileManager(path: string): void {
  if (process.platform === 'darwin') launch('open', ['-R', path]);
  else if (process.platform === 'win32') launch('explorer', [`/select,${path}`]);
  else launch('xdg-open', [path.replace(/[\\/][^\\/]*$/, '') || '.']);
}
