import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, parseConfig, readConfig, resolveApiUrl, writeConfig } from '../src/config.js';

const DEVICE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('parseConfig', () => {
  it('keeps well-formed fields', () => {
    expect(
      parseConfig({ apiUrl: 'https://tg.example', apiKey: 'tg_abc', deviceId: DEVICE, username: 'someone' }),
    ).toEqual({ apiUrl: 'https://tg.example', apiKey: 'tg_abc', deviceId: DEVICE, username: 'someone' });
  });

  it('drops malformed fields instead of trusting them', () => {
    expect(
      parseConfig({ apiUrl: 'javascript:alert(1)', apiKey: 'ghp_other', deviceId: 'my-laptop', username: 42 }),
    ).toEqual({});
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig('nope')).toEqual({});
  });
});

describe('resolveApiUrl', () => {
  it('prefers the flag, then the environment, then the config, then the default', () => {
    const config = { apiUrl: 'https://from-config.example' };
    const env = { TOKENGRAPH_API_URL: 'https://from-env.example' };
    expect(resolveApiUrl(config, 'https://from-flag.example', env)).toBe('https://from-flag.example');
    expect(resolveApiUrl(config, undefined, env)).toBe('https://from-env.example');
    expect(resolveApiUrl(config, undefined, {})).toBe('https://from-config.example');
    expect(resolveApiUrl({}, undefined, {})).toBe(DEFAULT_API_URL);
  });

  it('strips trailing slashes so paths join cleanly', () => {
    expect(resolveApiUrl({}, 'https://tg.example//', {})).toBe('https://tg.example');
  });
});

describe('config persistence', () => {
  it('round-trips and is readable only by its owner', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'token-graph-')), 'nested', 'config.json');
    await writeConfig({ apiKey: 'tg_secret', deviceId: DEVICE }, path);
    expect(await readConfig(path)).toEqual({ apiKey: 'tg_secret', deviceId: DEVICE });
    // Windows has no POSIX file modes, so this bit is only meaningful on POSIX platforms.
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('treats a missing file as an empty config', async () => {
    expect(await readConfig(join(tmpdir(), 'token-graph-does-not-exist.json'))).toEqual({});
  });
});

describe('uploads flag', () => {
  it('keeps a boolean and drops anything else', () => {
    expect(parseConfig({ uploads: false })).toEqual({ uploads: false });
    expect(parseConfig({ uploads: true })).toEqual({ uploads: true });
    expect(parseConfig({ uploads: 'no' })).toEqual({});
    expect(parseConfig({ uploads: 0 })).toEqual({});
  });

  it('round-trips through writeConfig/readConfig', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const path = join(dir, 'config.json');
    await writeConfig({ uploads: false }, path);
    expect(await readConfig(path)).toEqual({ uploads: false });
  });
});
