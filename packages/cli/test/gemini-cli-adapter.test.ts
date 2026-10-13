import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeminiCliAdapter } from '../src/adapters/gemini-cli/index.js';

// Relative to now, not a fixed date: these tests collect with a "last 24 hours" window, so a
// hard-coded timestamp silently falls outside it the day after it was written.
const T = new Date().toISOString();

function tokens(overrides: Record<string, number> = {}) {
  return { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120, ...overrides };
}

function geminiMessage(id: string, overrides: Record<string, unknown> = {}) {
  return { id, timestamp: T, type: 'gemini', content: 'secret', model: 'gemini-2.5-pro', tokens: tokens(), ...overrides };
}

function legacyDocument(id: string): string {
  return JSON.stringify({ sessionId: 's1', projectHash: 'h1', startTime: T, lastUpdated: T, messages: [geminiMessage(id)] });
}

describe('createGeminiCliAdapter', () => {
  let home: string;
  let realHome: string;
  const previousGeminiHome = process.env['GEMINI_CLI_HOME'];
  const previousHome = process.env['HOME'];
  const previousUserProfile = process.env['USERPROFILE'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gemini-home-'));
    realHome = await mkdtemp(join(tmpdir(), 'gemini-real-home-'));
    process.env['GEMINI_CLI_HOME'] = home;
    // An empty HOME so ~/.cache/.gemini is never the developer's real one.
    process.env['HOME'] = realHome;
    // os.homedir() reads USERPROFILE on Windows, not HOME — keep both pointed at the temp dir.
    process.env['USERPROFILE'] = realHome;
  });

  afterEach(async () => {
    if (previousGeminiHome === undefined) delete process.env['GEMINI_CLI_HOME'];
    else process.env['GEMINI_CLI_HOME'] = previousGeminiHome;
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (previousUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = previousUserProfile;
    await rm(home, { recursive: true, force: true });
    await rm(realHome, { recursive: true, force: true });
  });

  it('is not detected without a .gemini/tmp or ~/.cache/.gemini/tmp directory', async () => {
    expect(await createGeminiCliAdapter().detect()).toBe(false);
  });

  it('reads main, duplicate, legacy and subagent sessions, and ignores non-chat project files', async () => {
    const hashChats = join(home, '.gemini', 'tmp', 'hash123', 'chats');
    const slugChats = join(home, '.gemini', 'tmp', 'my-project', 'chats');
    const subChats = join(slugChats, 'parent-session-id');
    await mkdir(hashChats, { recursive: true });
    await mkdir(subChats, { recursive: true });

    // Main session, written under both the pre- and post-migration project directories: same id.
    await writeFile(join(hashChats, 'session-a.jsonl'), JSON.stringify(geminiMessage('r1')));
    await writeFile(join(slugChats, 'session-a.jsonl'), JSON.stringify(geminiMessage('r1')));
    // Legacy single-document format.
    await writeFile(join(slugChats, 'session-b.json'), legacyDocument('r2'));
    // Subagent session, counted separately from the main one.
    await writeFile(join(subChats, 'sub.jsonl'), JSON.stringify(geminiMessage('r3')));
    // Never read: gemini-shaped messages with tokens outside chats/ must not be picked up.
    await writeFile(join(home, '.gemini', 'tmp', 'my-project', 'logs.json'), JSON.stringify({ messages: [geminiMessage('should-not-count')] }));
    await writeFile(join(home, '.gemini', 'tmp', 'my-project', 'checkpoint-x.json'), JSON.stringify(geminiMessage('also-not-counted')));

    const adapter = createGeminiCliAdapter({ timeZone: 'UTC' });
    expect(adapter.name).toBe('gemini-cli');
    expect(await adapter.detect()).toBe(true);
    const result = await adapter.collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(3);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({ date: T.slice(0, 10), model: 'gemini-2.5-pro', counts: { inputTokens: 300, outputTokens: 60 } });
  });

  it('notes a session file that could not be read, while still counting the others', async () => {
    const chats = join(home, '.gemini', 'tmp', 'proj', 'chats');
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, 'broken.json'), '{"messages": [');
    await writeFile(join(chats, 'session-a.jsonl'), JSON.stringify(geminiMessage('r1')));

    const result = await createGeminiCliAdapter().collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(1);
    expect(result.notes?.some((note) => note.includes('could not be read'))).toBe(true);
  });

  it('skips a file whose mtime is older than since', async () => {
    const chats = join(home, '.gemini', 'tmp', 'proj', 'chats');
    await mkdir(chats, { recursive: true });
    const path = join(chats, 'session-old.jsonl');
    await writeFile(path, JSON.stringify(geminiMessage('old')));
    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(path, old, old);

    const result = await createGeminiCliAdapter().collect(new Date(Date.now() - 86_400_000));
    expect(result.requestCount).toBe(0);
  });
});
