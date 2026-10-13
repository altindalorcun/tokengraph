import { describe, expect, it } from 'vitest';
import { stableNodePath } from '../src/node-path.js';

const yes = () => true;
const no = () => false;

describe('stableNodePath', () => {
  it('maps a Homebrew Cellar path to the unversioned opt symlink when it exists', () => {
    const seen: string[] = [];
    const exists = (p: string) => (seen.push(p), true);
    expect(stableNodePath('/opt/homebrew/Cellar/node/25.2.1/bin/node', exists)).toBe('/opt/homebrew/opt/node/bin/node');
    expect(seen).toEqual(['/opt/homebrew/opt/node/bin/node']);
  });

  it('handles versioned formulae and other prefixes', () => {
    expect(stableNodePath('/usr/local/Cellar/node@22/22.11.0_1/bin/node', yes)).toBe('/usr/local/opt/node@22/bin/node');
  });

  it('keeps the Cellar path when the opt symlink is missing', () => {
    const p = '/opt/homebrew/Cellar/node/25.2.1/bin/node';
    expect(stableNodePath(p, no)).toBe(p);
  });

  it('leaves other layouts unchanged', () => {
    for (const p of [
      '/usr/local/bin/node',
      '/Users/x/.nvm/versions/node/v22.1.0/bin/node',
      '/Users/x/.volta/tools/image/node/22.1.0/bin/node',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Cellar\\node\\1.0\\bin\\node',
    ]) {
      expect(stableNodePath(p, yes)).toBe(p);
    }
  });
});
