import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadUsage } from '../src/api.js';
import type { UsagePayload } from '@tokengraph/core';

const PAYLOAD = { deviceId: 'd', source: 'claude-code', days: [] } as unknown as UsagePayload;

describe('uploadUsage trigger header', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, days: 0, rows: 0 })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    return calls[0][1].headers as Record<string, string>;
  }

  it('sends the given trigger', async () => {
    const fetchMock = stubFetch();
    await uploadUsage('http://x', 'k', PAYLOAD, 'hook');
    expect(sentHeaders(fetchMock)['X-Token-Graph-Trigger']).toBe('hook');
  });

  it('defaults to manual', async () => {
    const fetchMock = stubFetch();
    await uploadUsage('http://x', 'k', PAYLOAD);
    expect(sentHeaders(fetchMock)['X-Token-Graph-Trigger']).toBe('manual');
  });
});
