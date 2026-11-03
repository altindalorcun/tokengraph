import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstPublish, INSTALL_AND_SCHEDULE, offerSchedule, type OfferScheduleDeps } from '../src/commands/login-finish.js';
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

describe('offerSchedule', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const BIN = '/usr/local/lib/node_modules/tokengraph/bundle/bin.js';

  function deps(over: Partial<OfferScheduleDeps> = {}) {
    const d = {
      ephemeral: () => true,
      confirm: vi.fn(async () => true),
      schedule: vi.fn(async () => 0),
      version: () => '0.2.0',
      install: vi.fn(async () => 0),
      installedBin: vi.fn(async () => BIN as string | null),
      runInstalled: vi.fn(async () => 0),
      ...over,
    };
    return d;
  }

  it('turns the schedule on from a lasting install, without installing anything', async () => {
    const d = deps({ ephemeral: () => false });
    await offerSchedule(d);
    expect(d.confirm).toHaveBeenCalledWith('\nKeep your graph updated every hour?');
    expect(d.schedule).toHaveBeenCalledOnce();
    expect(d.install).not.toHaveBeenCalled();
  });

  it('from npx, installs this version globally after a yes, then runs the installed copy\'s schedule', async () => {
    const d = deps();
    await offerSchedule(d);
    expect(out.join('\n')).toContain('npm install -g tokengraph@0.2.0');
    expect(d.confirm).toHaveBeenCalledWith('Install tokengraph and keep your graph updated every hour?');
    expect(d.install).toHaveBeenCalledWith('0.2.0');
    expect(d.runInstalled).toHaveBeenCalledWith(BIN, ['schedule']);
    // The npx copy must never install the schedule itself: it would point at the cache.
    expect(d.schedule).not.toHaveBeenCalled();
  });

  it('installs latest when the running version is not a plain release', async () => {
    const d = deps({ version: () => 'unknown' });
    await offerSchedule(d);
    expect(d.install).toHaveBeenCalledWith('latest');
  });

  it('changes nothing on a no and prints the command for later', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    await offerSchedule(d);
    expect(d.install).not.toHaveBeenCalled();
    expect(d.runInstalled).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain(INSTALL_AND_SCHEDULE);
  });

  it('points at the permissions guide when npm fails, and does not try the schedule', async () => {
    const d = deps({ install: vi.fn(async () => 243) });
    await offerSchedule(d);
    expect(d.runInstalled).not.toHaveBeenCalled();
    const text = out.join('\n');
    expect(text).toContain('EACCES');
    expect(text).toContain(INSTALL_AND_SCHEDULE);
  });

  it('asks for the schedule by hand when the installed copy cannot be found', async () => {
    const d = deps({ installedBin: vi.fn(async () => null) });
    await offerSchedule(d);
    expect(d.runInstalled).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('tokengraph schedule');
  });

  it('says the schedule is not on when the installed copy fails to turn it on', async () => {
    const d = deps({ runInstalled: vi.fn(async () => 1) });
    await offerSchedule(d);
    expect(out.join('\n')).toContain('The hourly sync is not on yet');
  });
});
