import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstPublish } from '../src/commands/login-finish.js';
import { SYNC_NO_AGENTS, SYNC_SKIPPED } from '../src/commands/sync.js';

describe('firstPublish', () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      err.push(String(line));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('says it is publishing, then shows the snippet', async () => {
    const readme = vi.fn(async () => 0);
    expect(await firstPublish({ sync: async () => 0, readme })).toBe(0);
    expect(out[0]).toBe('Publishing your graph…');
    expect(readme).toHaveBeenCalledOnce();
  });

  it('asks for a star once the snippet is shown, and not before', async () => {
    const order: string[] = [];
    const readme = vi.fn(async () => {
      order.push('readme');
      return 0;
    });
    vi.mocked(console.log).mockImplementation((line: unknown) => {
      if (String(line).includes('github.com/altindalorcun/tokengraph')) order.push('star');
    });
    expect(await firstPublish({ sync: async () => 0, readme })).toBe(0);
    expect(order).toEqual(['readme', 'star']);
  });

  it('does not ask for a star when the snippet could not be printed', async () => {
    expect(await firstPublish({ sync: async () => 0, readme: async () => 1 })).toBe(1);
    expect(out.join('\n')).not.toContain('github.com/altindalorcun');
  });

  it('is not an error when another sync holds the lock', async () => {
    const readme = vi.fn(async () => 1);
    expect(await firstPublish({ sync: async () => SYNC_SKIPPED, readme })).toBe(0);
    expect(out.join('\n')).toContain('Another sync is running; your graph will be published when it finishes. Run `tokengraph readme` afterwards.');
    expect(readme).not.toHaveBeenCalled();
    expect(err).toEqual([]);
  });

  it('is not an error when there is no agent usage yet', async () => {
    const readme = vi.fn(async () => 1);
    expect(await firstPublish({ sync: async () => SYNC_NO_AGENTS, readme })).toBe(0);
    expect(out.join('\n')).toContain('No agent usage found yet — your graph will appear after your first session.');
    expect(readme).not.toHaveBeenCalled();
  });

  it('still fails when the publish itself failed', async () => {
    expect(await firstPublish({ sync: async () => 1, readme: async () => 0 })).toBe(1);
  });
});
