import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateLegacyHome } from '../src/paths.js';

const OLD = join(homedir(), '.token-graph');
const NEW = join(homedir(), '.tokengraph');

function harness(existing: string[], rename: (from: string, to: string) => void = () => undefined) {
  const renames: [string, string][] = [];
  return {
    renames,
    deps: {
      exists: (path: string) => existing.includes(path),
      rename: (from: string, to: string) => {
        rename(from, to);
        renames.push([from, to]);
      },
    },
  };
}

describe('migrateLegacyHome', () => {
  it('moves ~/.token-graph to ~/.tokengraph once', () => {
    const h = harness([OLD]);
    expect(migrateLegacyHome(h.deps, {})).toBe('moved');
    expect(h.renames).toEqual([[OLD, NEW]]);
  });

  it('never touches a folder that already exists', () => {
    const h = harness([OLD, NEW]);
    expect(migrateLegacyHome(h.deps, {})).toBe('none');
    expect(h.renames).toEqual([]);
  });

  it('does nothing without an old folder', () => {
    const h = harness([]);
    expect(migrateLegacyHome(h.deps, {})).toBe('none');
    expect(h.renames).toEqual([]);
  });

  it('is skipped when TOKENGRAPH_HOME is set', () => {
    const h = harness([OLD]);
    expect(migrateLegacyHome(h.deps, { TOKENGRAPH_HOME: '/elsewhere' })).toBe('none');
    expect(h.renames).toEqual([]);
  });

  it('treats a blank TOKENGRAPH_HOME as unset', () => {
    const h = harness([OLD]);
    expect(migrateLegacyHome(h.deps, { TOKENGRAPH_HOME: '  ' })).toBe('moved');
  });

  it('reports a failed rename without throwing', () => {
    const h = harness([OLD], () => {
      throw new Error('EACCES');
    });
    expect(migrateLegacyHome(h.deps, {})).toBe('failed');
  });
});
