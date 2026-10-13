import { describe, expect, it } from 'vitest';
import { removeCodexNotify, setCodexNotify } from '../src/codex-config-toml.js';

const ARGS = ['/usr/local/bin/node', '/opt/lib/node_modules/token-graph/dist/bin.js', 'hook-sync', '--min-interval', '600'];
const OURS =
  'notify = ["/usr/local/bin/node", "/opt/lib/node_modules/token-graph/dist/bin.js", "hook-sync", "--min-interval", "600"]';

describe('setCodexNotify', () => {
  it('adds notify at the top of an empty or table-only file', () => {
    expect(setCodexNotify('', ARGS)).toEqual({ kind: 'written', text: `${OURS}\n`, replacedOlder: false });
    const r = setCodexNotify('model = "o3"\n[profiles.work]\nnotify = ["say"]\n', ARGS);
    expect(r).toMatchObject({ kind: 'written' });
    expect((r as { text: string }).text.startsWith(`${OURS}\n`)).toBe(true);
    expect((r as { text: string }).text).toContain('[profiles.work]\nnotify = ["say"]');
  });

  it('ignores a notify inside a table and a foreign one only counts at the top level', () => {
    const text = '[profiles.work]\nnotify = ["python3", "/me/notify.py"]\n';
    expect(setCodexNotify(text, ARGS)).toEqual({ kind: 'written', text: `${OURS}\n${text}`, replacedOlder: false });
  });

  it('refuses to replace a notify that is not ours', () => {
    expect(setCodexNotify('notify = ["python3", "/me/notify.py"]\n', ARGS)).toEqual({
      kind: 'foreign',
      existing: 'notify = ["python3", "/me/notify.py"]',
    });
  });

  it('refuses a foreign multi-line notify and reports all of it', () => {
    const text = 'notify = [\n  "python3",\n  "/me/notify.py",\n]\n';
    expect(setCodexNotify(text, ARGS)).toEqual({ kind: 'foreign', existing: 'notify = [\n  "python3",\n  "/me/notify.py",\n]' });
  });

  it('does not mistake another tool\'s bin.js for ours', () => {
    const text = 'notify = ["node", "/opt/other/bin.js", "hook-sync"]\n';
    expect(setCodexNotify(text, ARGS).kind).toBe('foreign');
  });

  it('is unchanged when ours is already there, and updates an older form of ours', () => {
    expect(setCodexNotify(`${OURS}\n`, ARGS).kind).toBe('unchanged');
    const older = 'notify = ["/old/node", "/old/token-graph/dist/bin.js", "hook-sync"]\nmodel = "o3"\n';
    expect(setCodexNotify(older, ARGS)).toEqual({ kind: 'written', text: `${OURS}\nmodel = "o3"\n`, replacedOlder: true });
  });

  it('handles a multi-line array', () => {
    const text = 'notify = [\n  "/old/node",\n  "/old/token-graph/dist/bin.js",\n  "hook-sync",\n]\n';
    expect(setCodexNotify(text, ARGS)).toEqual({ kind: 'written', text: `${OURS}\n`, replacedOlder: true });
  });

  it('ignores a trailing comment when reading the array', () => {
    expect(setCodexNotify(`${OURS} # "keep"\n`, ARGS).kind).toBe('unchanged');
    expect(setCodexNotify('notify = ["say"] # "token-graph" "bin.js"\n', ARGS).kind).toBe('foreign');
  });

  it('keeps CRLF line endings', () => {
    const older = 'notify = ["/old/node", "/old/token-graph/dist/bin.js", "hook-sync"]\r\nmodel = "o3"\r\n';
    expect(setCodexNotify(older, ARGS)).toMatchObject({ text: `${OURS}\r\nmodel = "o3"\r\n` });
    expect(setCodexNotify('model = "o3"\r\n', ARGS)).toMatchObject({ text: `${OURS}\r\nmodel = "o3"\r\n` });
  });

  it('escapes arguments as TOML basic strings', () => {
    const result = setCodexNotify('', ['C:\\Program Files\\node.exe', 'C:\\x\\token-graph\\bin.js', 'hook-sync']);
    expect(result).toMatchObject({
      text: 'notify = ["C:\\\\Program Files\\\\node.exe", "C:\\\\x\\\\token-graph\\\\bin.js", "hook-sync"]\n',
    });
    expect(setCodexNotify((result as { text: string }).text, ['C:\\Program Files\\node.exe', 'C:\\x\\token-graph\\bin.js', 'hook-sync']).kind).toBe('unchanged');
  });
});

describe('removeCodexNotify', () => {
  it('removes only our notify', () => {
    expect(removeCodexNotify(`${OURS}\nmodel = "o3"\n`)).toEqual({ kind: 'written', text: 'model = "o3"\n', replacedOlder: false });
    expect(removeCodexNotify('notify = ["say"]\n').kind).toBe('unchanged');
    expect(removeCodexNotify('model = "o3"\n').kind).toBe('unchanged');
  });

  it('removes a multi-line notify of ours', () => {
    const text = 'notify = [\n  "/old/node",\n  "/old/token-graph/dist/bin.js",\n  "hook-sync",\n]\nmodel = "o3"\n';
    expect(removeCodexNotify(text)).toMatchObject({ kind: 'written', text: 'model = "o3"\n' });
  });
});
