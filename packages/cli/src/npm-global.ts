import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { forwardLines } from './child-output.js';

const NPM_ROOT_TIMEOUT_MS = 10_000;

// npm is npm.cmd on Windows, and Node only starts a .cmd through a shell. Callers pass fixed text plus a version
// that matched a release pattern, so nothing a user typed reaches that shell.
export function spawnNpm(args: readonly string[], stdio: StdioOptions): ChildProcess {
  if (process.platform === 'win32') return spawn(`npm ${args.join(' ')}`, { shell: true, stdio, windowsHide: true });
  return spawn('npm', args, { stdio });
}

/** npm's global node_modules folder (`npm root -g`), resolved through symlinks, or null when npm cannot say. */
export function npmGlobalRoot(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnNpm(['root', '-g'], ['ignore', 'pipe', 'ignore']);
    const timer = setTimeout(() => child.kill(), NPM_ROOT_TIMEOUT_MS);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      const root = out.trim();
      if (code !== 0 || root === '') return resolve(null);
      // Compared with the entry script's path, which Node has already resolved through any symlink.
      realpath(root).then(resolve, () => resolve(root));
    });
  });
}

/** Where `npm install -g tokengraph` puts the entry script, inside npm's global root. */
export function globalBinPath(npmRoot: string): string {
  return join(npmRoot, 'tokengraph', 'bundle', 'bin.js');
}

/**
 * `npm install -g tokengraph@<version>`. Resolves with npm's exit code. npm's own output goes to this terminal, or
 * line by line to `output` when given (the terminal view, which owns the screen); npm then gets no stdin either.
 */
export function installGlobally(version: string, output?: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnNpm(['install', '-g', `tokengraph@${version}`], output ? ['ignore', 'pipe', 'pipe'] : 'inherit');
    if (output) {
      forwardLines(child.stdout, output);
      forwardLines(child.stderr, output);
    }
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
