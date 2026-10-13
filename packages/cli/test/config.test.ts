import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, readConfig, writeConfig } from '../src/config.js';

const ID = '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40';

describe('parseConfig', () => {
  it('reads the local-first fields', () => {
    expect(
      parseConfig({
        machineId: ID,
        github: { login: 'octocat', auth: { kind: 'token', token: 'gho_abc' } },
        gists: { graph: 'aa11bb22cc33dd44ee55', data: '0123456789abcdef0123456789abcdef' },
        graph: { colors: 'single' },
      }),
    ).toEqual({
      machineId: ID,
      github: { login: 'octocat', auth: { kind: 'token', token: 'gho_abc' } },
      gists: { graph: 'aa11bb22cc33dd44ee55', data: '0123456789abcdef0123456789abcdef' },
      graph: { colors: 'single' },
    });
  });

  it('keeps a gh-backed account', () => {
    expect(parseConfig({ github: { login: 'octocat', auth: { kind: 'gh', ghPath: '/opt/homebrew/bin/gh' } } }).github).toEqual({
      login: 'octocat',
      auth: { kind: 'gh', ghPath: '/opt/homebrew/bin/gh' },
    });
  });

  it('turns a hosted-era deviceId into the machine id and drops the server fields', () => {
    expect(parseConfig({ apiUrl: 'http://localhost:3000', apiKey: 'tg_x', deviceId: ID, username: 'o', uploads: false })).toEqual({ machineId: ID });
  });

  it('prefers machineId over a legacy deviceId', () => {
    const other = '11111111-2222-4333-8444-555555555555';
    expect(parseConfig({ machineId: ID, deviceId: other }).machineId).toBe(ID);
  });

  it('accepts underscores in logins (Enterprise Managed Users) but not at the start', () => {
    const auth = { kind: 'token', token: 'x' };
    expect(parseConfig({ github: { login: 'name_corp', auth } }).github?.login).toBe('name_corp');
    expect(parseConfig({ github: { login: 'a-b_c', auth } }).github?.login).toBe('a-b_c');
    expect(parseConfig({ github: { login: '_name', auth } })).toEqual({});
    expect(parseConfig({ github: { login: 'name-_corp', auth } })).toEqual({});
  });

  it('drops malformed values instead of failing', () => {
    expect(
      parseConfig({
        machineId: 'nope',
        github: { login: 'bad login!', auth: { kind: 'token', token: 'x' } },
        gists: { graph: 'not hex', data: 42 },
        graph: { colors: 'rainbow' },
      }),
    ).toEqual({});
    expect(parseConfig({ github: { login: 'octocat', auth: { kind: 'token', token: '' } } })).toEqual({});
    expect(parseConfig(null)).toEqual({});
  });
});

describe('writeConfig', () => {
  it('writes an owner-only file that reads back the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tg-config-'));
    const path = join(dir, 'nested', 'config.json');
    const config = { machineId: ID, github: { login: 'octocat', auth: { kind: 'token' as const, token: 'gho_abc' } } };
    await writeConfig(config, path);
    expect(await readConfig(path)).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config);
  });
});
