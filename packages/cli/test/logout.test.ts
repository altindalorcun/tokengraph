import { describe, expect, it } from 'vitest';
import { runLogout } from '../src/commands/logout.js';
import { readConfig, writeConfig } from '../src/config.js';

describe('logout', () => {
  it('forgets the account and gists but keeps the machine id', async () => {
    await writeConfig({
      machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40',
      github: { login: 'octocat', auth: { kind: 'token', token: 'gho_x' } },
      gists: { graph: 'aaaaaaaaaaaaaaaaaaaa', data: 'bbbbbbbbbbbbbbbbbbbb' },
      graph: { colors: 'single' },
    });
    expect(await runLogout()).toBe(0);
    expect(await readConfig()).toEqual({ machineId: '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40', graph: { colors: 'single' } });
  });
});
