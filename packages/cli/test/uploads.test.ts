import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUploads } from '../src/commands/uploads.js';
import { readConfig, writeConfig } from '../src/config.js';

describe('token-graph uploads', () => {
  let root: string;
  let saved: string | undefined;
  let logs: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'uploads-'));
    saved = process.env['TOKENGRAPH_HOME'];
    process.env['TOKENGRAPH_HOME'] = root;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => void logs.push(line));
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env['TOKENGRAPH_HOME'];
    else process.env['TOKENGRAPH_HOME'] = saved;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('shows the current mode without an argument', async () => {
    expect(await runUploads(undefined)).toBe(0);
    expect(logs.join('\n')).toContain('not logged in');
  });

  it('switches uploads off and on, keeping other fields', async () => {
    await writeConfig({ username: 'octo' });
    expect(await runUploads('off')).toBe(0);
    expect(await readConfig()).toEqual({ username: 'octo', uploads: false });
    expect(await runUploads('on')).toBe(0);
    expect(await readConfig()).toEqual({ username: 'octo', uploads: true });
  });

  it('rejects anything else', async () => {
    expect(await runUploads('maybe')).toBe(1);
    expect(logs.join('\n')).toContain('on or off');
  });
});
