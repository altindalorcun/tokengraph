import { describe, expect, it } from 'vitest';
import { emptyLedger, mergeUsage, type Ledger } from '../src/ledger.js';
import { GRAPH_MARKER } from '../src/publish/gists.js';
import { machineFileName, parseMachineFile } from '../src/publish/machines.js';
import { publish, type PublishInput } from '../src/publish/publish.js';
import { fakeGitHubClient, type FakeGitHub } from './fake-github-client.js';

const A = '3f2a1c9e-0b7d-4c1e-9a55-2d8f6b1e7c40';
const B = '11111111-2222-4333-8444-555555555555';
const counts = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
const ledgerWith = (date: string, input: number): Ledger =>
  mergeUsage(emptyLedger(), 'claude-code', [{ date, model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(input) }]);

function input(client: FakeGitHub, overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    client,
    login: 'octocat',
    config: { github: { login: 'octocat', auth: { kind: 'token', token: 't' } } },
    ledger: ledgerWith('2026-10-12', 1000),
    today: '2026-10-13',
    nowIso: '2026-10-13T10:00:00.000Z',
    cliVersion: '0.1.0',
    platform: 'darwin',
    fingerprint: 'fp-a',
    newMachineId: () => A,
    persistMachineId: async () => undefined,
    ...overrides,
  };
}

describe('publish', () => {
  it('saves the machine id before the first write, so a failing graph step cannot lose it', async () => {
    const client = fakeGitHubClient();
    const events: string[] = [];
    const updateGist = client.updateGist.bind(client);
    client.updateGist = async (id, files) => {
      events.push(`update ${Object.keys(files).join(',')}`);
      if (Object.keys(files).includes('README.md')) throw new Error('graph step failed');
      return updateGist(id, files);
    };
    const persistMachineId = async (id: string) => {
      events.push(`persist ${id}`);
    };
    await expect(publish(input(client, { persistMachineId }))).rejects.toThrow('graph step failed');
    expect(events[0]).toBe(`persist ${A}`);
    expect(events[1]).toContain(machineFileName(A));
  });

  it('replaces cached gist ids that another account owns instead of failing on every sync', async () => {
    const client = fakeGitHubClient('octocat');
    const foreignGraph = 'c'.repeat(20);
    const foreignData = 'd'.repeat(20);
    client.gists.set(foreignGraph, { id: foreignGraph, description: null, public: true, html_url: '', files: { [GRAPH_MARKER]: { filename: GRAPH_MARKER } }, owner: { login: 'someone-else' } });
    client.gists.set(foreignData, { id: foreignData, description: null, public: false, html_url: '', files: { 'tokengraph-data.md': { filename: 'tokengraph-data.md' } }, owner: { login: 'someone-else' } });
    const result = await publish(input(client, { config: { github: { login: 'octocat', auth: { kind: 'token', token: 't' } }, gists: { graph: foreignGraph, data: foreignData } } }));
    expect(result.graphGistId).not.toBe(foreignGraph);
    expect(result.dataGistId).not.toBe(foreignData);
    expect(result.graphGistReplaced).toBe(true);
  });

  it('first run: creates both gists, writes the machine file and the graph', async () => {
    const client = fakeGitHubClient();
    const result = await publish(input(client));
    expect(result.config.machineId).toBe(A);
    expect(result.config.gists).toEqual({ graph: result.graphGistId, data: result.dataGistId });
    expect(result.graphGistCreated).toBe(true);
    expect(result.wroteMachineFile).toBe(true);
    const data = client.gists.get(result.dataGistId)!;
    expect(data.public).toBe(false);
    expect(parseMachineFile(data.files[machineFileName(A)]!.content!)?.fingerprint).toBe('fp-a');
    const graph = client.gists.get(result.graphGistId)!;
    expect(graph.public).toBe(true);
    expect(graph.files['README.md']!.content).toContain(result.graphGistId);
    expect(JSON.stringify(graph.files)).not.toContain('claude-opus-5-5');
  });

  it('second run with nothing new sends no writes', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    client.calls.length = 0;
    const second = await publish(input(client, { config: first.config, nowIso: '2026-10-13T11:00:00.000Z' }));
    expect(second.wroteMachineFile).toBe(false);
    expect(second.updatedGraphFiles).toEqual([]);
    expect(client.calls.filter((call) => call.method !== 'getGist')).toEqual([]);
  });

  it('a second machine adds up, and only ever writes its own file', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    const firstLight = client.gists.get(first.graphGistId)!.files['tokengraph-light.svg']!.content;
    client.calls.length = 0;
    const second = await publish(
      input(client, { config: { github: first.config.github }, ledger: ledgerWith('2026-10-12', 500), fingerprint: 'fp-b', newMachineId: () => B }),
    );
    expect(second.config.machineId).toBe(B);
    expect(second.others.map((other) => other.machineId)).toEqual([A]);
    const patches = client.calls.filter((call) => call.method === 'updateGist' && call.id === second.dataGistId);
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]!.files!)).toEqual([machineFileName(B)]);
    expect(client.calls.some((call) => call.method === 'createGist')).toBe(false);
    expect(client.gists.get(second.graphGistId)!.files['tokengraph-light.svg']!.content).not.toBe(firstLight);
  });

  it('never overwrites its own machine file when it cannot be read', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    const name = machineFileName(A);
    client.gists.get(first.dataGistId)!.files[name] = { filename: name, content: '{"schema":2}' };
    client.calls.length = 0;
    const again = await publish(input(client, { config: first.config, ledger: ledgerWith('2026-10-12', 5) }));
    expect(again.ownFileUnreadable).toBe(true);
    expect(again.wroteMachineFile).toBe(false);
    expect(client.calls.some((call) => call.method === 'updateGist' && name in (call.files ?? {}))).toBe(false);
    expect(client.gists.get(first.dataGistId)!.files[name]!.content).toBe('{"schema":2}');
    expect(first.ownFileUnreadable).toBe(false);
  });

  it('restores lost local history from its own file and never shrinks', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client, { ledger: mergeUsage(ledgerWith('2026-10-12', 1000), 'claude-code', [{ date: '2026-08-01', model: 'claude-opus-5-5', pricingTier: 'standard', counts: counts(9) }]) }));
    const wiped = await publish(input(client, { config: first.config, ledger: ledgerWith('2026-10-12', 10) }));
    expect(wiped.restoredDays).toBe(1);
    expect(wiped.ledger.sources['claude-code']!['2026-10-12']!['claude-opus-5-5']!.standard!.inputTokens).toBe(1000);
  });

  it('adopts its old id after ~/.tokengraph was wiped (same fingerprint)', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    const again = await publish(input(client, { config: { github: first.config.github }, newMachineId: () => B }));
    expect(again.adopted).toBe(true);
    expect(again.config.machineId).toBe(A);
    expect(again.others).toEqual([]);
  });

  it('recreates a deleted graph gist and reports it', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    client.gists.delete(first.graphGistId);
    const again = await publish(input(client, { config: first.config }));
    expect(again.graphGistReplaced).toBe(true);
    expect(again.graphGistId).not.toBe(first.graphGistId);
    expect(client.gists.get(again.graphGistId)!.files[GRAPH_MARKER]).toBeDefined();
  });

  it('ignores files in the data gist that are not machine files or do not parse', async () => {
    const client = fakeGitHubClient();
    const first = await publish(input(client));
    client.gists.get(first.dataGistId)!.files['machine-zzz.json'] = { filename: 'machine-zzz.json', content: 'garbage' };
    await expect(publish(input(client, { config: first.config }))).resolves.toMatchObject({ others: [] });
  });
});
