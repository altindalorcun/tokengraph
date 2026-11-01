import { describe, expect, it } from 'vitest';
import { RequestBuckets, type RequestRecord } from '../src/adapters/request-buckets.js';

const counts = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: null, cacheCreation1hTokens: null });
const request = (input: number, folder?: string | null, date = '2026-10-01'): RequestRecord => ({ date, hour: 9, model: 'm', pricingTier: 'standard', counts: counts(input), folder });

describe('RequestBuckets.toProjects', () => {
  it('groups by folder, date, model and tier', () => {
    const buckets = new RequestBuckets();
    buckets.add('a', request(1, '/w/x'));
    buckets.add('b', request(2, '/w/x'));
    buckets.add('c', request(4, '/w/y'));
    buckets.add('d', request(8, '/w/x', '2026-10-02'));
    expect(buckets.toProjects().map((row) => [row.folder, row.date, row.counts.inputTokens])).toEqual([
      ['/w/x', '2026-10-01', 3],
      ['/w/x', '2026-10-02', 8],
      ['/w/y', '2026-10-01', 4],
    ]);
  });

  it('leaves out requests with no folder', () => {
    const buckets = new RequestBuckets();
    buckets.add('a', request(1));
    buckets.add('b', request(2, null));
    expect(buckets.toProjects()).toEqual([]);
    expect(buckets.toUsage()).toHaveLength(1);
  });

  it('lets a later copy fill a missing folder but never move one', () => {
    const buckets = new RequestBuckets();
    buckets.add('a', request(1, null));
    buckets.add('a', request(1, '/w/x'));
    buckets.add('b', request(2, '/w/x'));
    buckets.add('b', request(2, '/w/moved'));
    expect(buckets.toProjects().map((row) => [row.folder, row.counts.inputTokens])).toEqual([['/w/x', 3]]);
  });

  it('sums to toUsage when every request has a folder', () => {
    const buckets = new RequestBuckets();
    buckets.add('a', request(1, '/w/x'));
    buckets.add('b', request(2, '/w/y'));
    const total = buckets.toProjects().reduce((sum, row) => sum + row.counts.inputTokens, 0);
    expect(total).toBe(buckets.toUsage()[0]!.counts.inputTokens);
  });
});
