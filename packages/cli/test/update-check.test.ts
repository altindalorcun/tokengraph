import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchLatestVersion,
  isNewerVersion,
  knownUpdate,
  refreshUpdateCheck,
  updateChecksEnabled,
  updateNotice,
} from '../src/update-check.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const registry = (version: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ name: 'tokengraph', version }), { status: 200 })) as unknown as typeof fetch;

describe('isNewerVersion', () => {
  it.each([
    ['0.1.2', '0.1.1', true],
    ['0.2.0', '0.1.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.1.10', '0.1.9', true],
    ['0.1.1', '0.1.1', false],
    ['0.1.0', '0.1.1', false],
  ])('%s over %s is %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });

  it('never offers a prerelease and never compares what it cannot read', () => {
    expect(isNewerVersion('0.2.0-beta.1', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.2.0', 'unknown')).toBe(false);
    expect(isNewerVersion('0.2.0; rm -rf ~', '0.1.1')).toBe(false);
  });
});

describe('updateChecksEnabled', () => {
  it('is on by default', () => {
    expect(updateChecksEnabled({}, {})).toBe(true);
  });

  it('stops for the config switch, its own variable, the common convention and CI', () => {
    expect(updateChecksEnabled({ update: { check: false } }, {})).toBe(false);
    expect(updateChecksEnabled({}, { TOKENGRAPH_NO_UPDATE_CHECK: '1' })).toBe(false);
    expect(updateChecksEnabled({}, { NO_UPDATE_NOTIFIER: '1' })).toBe(false);
    expect(updateChecksEnabled({}, { CI: 'true' })).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  it('reads the version the registry calls latest', async () => {
    const fetchImpl = registry('0.2.0');
    expect(await fetchLatestVersion({ fetch: fetchImpl, env: {} })).toBe('0.2.0');
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('https://registry.npmjs.org/tokengraph/latest');
  });

  it('asks a real server over HTTP at the overridden registry', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: request.url === '/tokengraph/latest' ? '3.2.1' : '0.0.0' }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await fetchLatestVersion({ env: { TOKENGRAPH_NPM_REGISTRY: `http://127.0.0.1:${port}/` } })).toBe('3.2.1');
    } finally {
      server.close();
    }
  });

  it('is silent without a network: a refused connection is just no answer', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetch: offline, env: {} })).toBeNull();
  });

  it('gives up on a server that never answers', async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetch: hanging, env: {}, timeoutMs: 10 })).toBeNull();
  });

  it('accepts nothing but a plain release number', async () => {
    for (const version of ['0.2.0-beta.1', '\x1b[31m9.9.9', 'latest', 9, null]) {
      expect(await fetchLatestVersion({ fetch: registry(version), env: {} })).toBeNull();
    }
    const down = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetch: down, env: {} })).toBeNull();
    const garbled = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetch: garbled, env: {} })).toBeNull();
  });
});

describe('the daily check', () => {
  let dir: string;
  let cachePath: string;
  let base: { env: NodeJS.ProcessEnv; config: object; cachePath: string; now: () => number; current: () => string };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokengraph-update-'));
    cachePath = join(dir, 'update-check.json');
    base = { env: {}, config: {}, cachePath, now: () => NOW, current: () => '0.1.1' };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('remembers the answer and offers the newer version', async () => {
    await refreshUpdateCheck({ ...base, fetch: registry('0.2.0') });
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual({ checkedAt: NOW, latest: '0.2.0' });
    expect(await knownUpdate(base)).toBe('0.2.0');
  });

  it('asks at most once a day', async () => {
    await refreshUpdateCheck({ ...base, fetch: registry('0.2.0') });
    const again = registry('0.3.0');
    await refreshUpdateCheck({ ...base, fetch: again, now: () => NOW + DAY_MS - 1 });
    expect(again).not.toHaveBeenCalled();
    await refreshUpdateCheck({ ...base, fetch: again, now: () => NOW + DAY_MS });
    expect(again).toHaveBeenCalledTimes(1);
    expect(await knownUpdate(base)).toBe('0.3.0');
  });

  it('asks again when the stored time is in the future: a wrong clock must not silence it for good', async () => {
    await writeFile(cachePath, JSON.stringify({ checkedAt: NOW + 10 * DAY_MS, latest: '0.1.1' }));
    const fetchImpl = registry('0.2.0');
    await refreshUpdateCheck({ ...base, fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('offers nothing once this copy has caught up', async () => {
    await refreshUpdateCheck({ ...base, fetch: registry('0.2.0') });
    expect(await knownUpdate({ ...base, current: () => '0.2.0' })).toBeNull();
    expect(await knownUpdate({ ...base, current: () => '0.3.0' })).toBeNull();
  });

  it('keeps what it knew when the network is gone, and never throws', async () => {
    await refreshUpdateCheck({ ...base, fetch: registry('0.2.0') });
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(refreshUpdateCheck({ ...base, fetch: offline, now: () => NOW + 2 * DAY_MS })).resolves.toBeUndefined();
    expect(await knownUpdate(base)).toBe('0.2.0');
  });

  it('never fails on an unwritable folder or a damaged file', async () => {
    const blocked = join(cachePath, 'nested', 'update-check.json');
    await writeFile(cachePath, 'not json');
    expect(await knownUpdate(base)).toBeNull();
    await expect(refreshUpdateCheck({ ...base, cachePath: blocked, fetch: registry('0.2.0') })).resolves.toBeUndefined();
  });

  it('ignores a stored version it would not accept from the registry', async () => {
    await writeFile(cachePath, JSON.stringify({ checkedAt: NOW, latest: '\x1b[31m9.9.9' }));
    expect(await knownUpdate(base)).toBeNull();
  });

  it('does not touch the network or show anything when turned off', async () => {
    await refreshUpdateCheck({ ...base, fetch: registry('0.2.0') });
    const off = { ...base, env: { TOKENGRAPH_NO_UPDATE_CHECK: '1' } };
    const fetchImpl = registry('0.3.0');
    await refreshUpdateCheck({ ...off, fetch: fetchImpl, now: () => NOW + 2 * DAY_MS });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await knownUpdate(off)).toBeNull();
  });
});

describe('updateNotice', () => {
  it('names both versions and the command', () => {
    expect(updateNotice('0.2.0', '0.1.1')).toBe('tokengraph 0.2.0 is available (you have 0.1.1). Run `tokengraph update` to get it.');
  });
});
