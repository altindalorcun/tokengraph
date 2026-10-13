import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeHostedLeftovers } from '../src/hosted-leftovers.js';

describe('removeHostedLeftovers', () => {
  it('deletes the upload record and leaves the ledger alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tg-leftovers-'));
    await writeFile(join(home, 'uploaded.json'), '{}');
    await writeFile(join(home, 'state.json'), '{}');
    await removeHostedLeftovers(home);
    expect(existsSync(join(home, 'uploaded.json'))).toBe(false);
    expect(existsSync(join(home, 'state.json'))).toBe(true);
  });

  it('does nothing when there is nothing to remove', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tg-leftovers-'));
    await expect(removeHostedLeftovers(home)).resolves.toBeUndefined();
    await expect(removeHostedLeftovers(join(home, 'missing'))).resolves.toBeUndefined();
  });
});
