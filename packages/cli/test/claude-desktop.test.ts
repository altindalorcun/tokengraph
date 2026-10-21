import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { CLAUDE_CODE_ROOTS } from '../src/adapters/claude-code/roots.js';
import { candidateRoots, parseKindedRoot, type RootContext } from '../src/agent-roots.js';

// There are no real Claude Desktop transcripts to copy from, so these fixtures follow the CLI's schema (the
// same parser reads them) and the folder layout tokscale documents: <app data>/{local-agent-mode-sessions,
// claude-code-sessions}/<account>/<org>/<session>/.claude/{projects,transcripts}.
const NOW = new Date().toISOString();

function line(id: string, input: number, output = 1): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: NOW,
    message: { id, model: 'claude-sonnet-5', usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
}

async function put(path: string, ...lines: string[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, lines.join('\n') + '\n');
}

describe('Claude Desktop sessions', () => {
  let home: string;
  let ctx: RootContext;
  let appData: string;
  const SINCE = new Date(Date.now() - 86_400_000);

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tg-desktop-'));
    ctx = { platform: process.platform, env: {}, home };
    const desktop = candidateRoots(CLAUDE_CODE_ROOTS, ctx).find(({ root }) => parseKindedRoot(root).kind === 'desktop');
    appData = parseKindedRoot(desktop!.root).path;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const adapter = (remembered: string[] = []) => createClaudeCodeAdapter({ timeZone: 'UTC', roots: { ctx, remembered } });
  const session = (kind: string, ...rest: string[]) => join(appData, kind, 'acct-uuid', 'org-uuid', 'local_session-1', '.claude', ...rest);

  it('puts the app data where the OS keeps it', () => {
    const suffix = { darwin: join('Library', 'Application Support', 'Claude'), win32: join('AppData', 'Roaming', 'Claude'), linux: join('.config', 'Claude') }[
      process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
    ];
    expect(appData).toBe(join(home, suffix));
  });

  it('reads projects/ and transcripts/ of every .claude under both session folders', async () => {
    await put(session('local-agent-mode-sessions', 'projects', '-work', 's1.jsonl'), line('msg_cowork', 100));
    await put(session('local-agent-mode-sessions', 'transcripts', 'ses_1.jsonl'), line('msg_transcript', 200));
    await put(session('claude-code-sessions', 'projects', '-repo', 's2.jsonl'), line('msg_code', 400));
    const result = await adapter().collect(SINCE);
    expect(result.requestCount).toBe(3);
    expect(result.usage[0]?.counts.inputTokens).toBe(700);
  });

  it('counts a message once when the CLI folder and a Desktop session both hold it', async () => {
    await put(join(home, '.claude', 'projects', '-repo', 'cli.jsonl'), line('msg_same', 100), line('msg_cli_only', 10));
    await put(session('claude-code-sessions', 'projects', '-repo', 'desktop.jsonl'), line('msg_same', 100), line('msg_desktop_only', 1000));
    const result = await adapter().collect(SINCE);
    expect(result.requestCount).toBe(3);
    expect(result.usage[0]?.counts.inputTokens).toBe(1110);
  });

  it('never reads audit.jsonl, a second copy of the same API traffic', async () => {
    await put(session('local-agent-mode-sessions', 'projects', '-work', 'audit.jsonl'), line('msg_audit_a', 9999));
    await put(session('local-agent-mode-sessions', 'transcripts', 'audit.jsonl'), line('msg_audit_b', 9999));
    await put(session('local-agent-mode-sessions', 'projects', '-work', 'real.jsonl'), line('msg_real', 5));
    const result = await adapter().collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts.inputTokens).toBe(5);
  });

  it('reads transcripts/ directly in the folder, not nested below it', async () => {
    await put(session('claude-code-sessions', 'transcripts', 'flat.jsonl'), line('msg_flat', 3));
    await put(session('claude-code-sessions', 'transcripts', 'nested', 'deep.jsonl'), line('msg_deep', 5000));
    const result = await adapter().collect(SINCE);
    expect(result.requestCount).toBe(1);
  });

  it('walks only the two session folders, never the rest of the app data', async () => {
    await put(join(appData, 'Cache', 'x', '.claude', 'projects', 'p', 's.jsonl'), line('msg_cache', 7777));
    await put(join(appData, 'IndexedDB', '.claude', 'projects', 'p', 's.jsonl'), line('msg_idb', 7777));
    await put(join(appData, 'claude-code', '2.1.304', '.claude', 'projects', 'p', 's.jsonl'), line('msg_bundled', 7777));
    expect((await adapter().collect(SINCE)).requestCount).toBe(0);
  });

  it('does not follow symlinks, whether to a folder or to a file', async () => {
    const outside = join(home, 'outside');
    await put(join(outside, '.claude', 'projects', 'p', 's.jsonl'), line('msg_linked_dir', 8888));
    await put(join(outside, 'file.jsonl'), line('msg_linked_file', 8888));
    const sessionDir = join(appData, 'local-agent-mode-sessions', 'acct', 'org');
    await mkdir(sessionDir, { recursive: true });
    try {
      await symlink(outside, join(sessionDir, 'linked-session'), 'dir');
      await mkdir(join(sessionDir, 'real', '.claude', 'projects', 'p'), { recursive: true });
      await symlink(join(outside, 'file.jsonl'), join(sessionDir, 'real', '.claude', 'projects', 'p', 'link.jsonl'), 'file');
    } catch {
      return; // Symlinks need a privilege on some Windows setups.
    }
    expect((await adapter().collect(SINCE)).requestCount).toBe(0);
  });

  it('is detected only when a session folder holds a .claude with transcripts', async () => {
    await put(join(appData, 'claude-code-sessions', 'acct', 'org', 'scheduled-tasks.json'), '{}');
    await put(join(appData, 'local-agent-mode-sessions', 'acct', 'org', 'rpm', 'manifest.json'), '{}');
    expect(await adapter().detect()).toBe(false);
    await put(session('local-agent-mode-sessions', 'projects', 'p', 's.jsonl'), line('msg_x', 1));
    expect(await adapter().detect()).toBe(true);
  });

  it('reads <claude config dir>/transcripts/*.jsonl next to projects/', async () => {
    await put(join(home, '.claude', 'transcripts', 'ses_a.jsonl'), line('msg_t', 12));
    await put(join(home, '.claude', 'transcripts', 'audit.jsonl'), line('msg_audit', 1234));
    const result = await adapter().collect(SINCE);
    expect(result.requestCount).toBe(1);
    expect(result.usage[0]?.counts.inputTokens).toBe(12);
  });
});
