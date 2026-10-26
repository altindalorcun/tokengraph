import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SYNC_EVENTS, checkHookEvent, friendlyParseError, parseSinceDays } from '../src/cli-args.js';

describe('parseSinceDays', () => {
  it('takes whole days from 1 to 400', () => {
    expect(parseSinceDays('1')).toBe(1);
    expect(parseSinceDays('90')).toBe(90);
    expect(parseSinceDays('400')).toBe(400);
  });

  it('rejects fractions, exponents, signs, garbage and out-of-range days', () => {
    for (const raw of ['1.5', '1e2', '7abc', '', ' 7', '+7', '-1', '0', '401', '0x10']) expect(parseSinceDays(raw)).toBeNull();
  });
});

describe('checkHookEvent', () => {
  it('accepts the Claude Code events that end a turn or a session', () => {
    for (const event of CLAUDE_SYNC_EVENTS) expect(checkHookEvent(event, false)).toBeNull();
  });

  it('rejects any other name when installing, and lists the valid ones', () => {
    const error = checkHookEvent('Bogus', false);
    expect(error).toContain('Bogus');
    for (const event of CLAUDE_SYNC_EVENTS) expect(error).toContain(event);
  });

  it('lets --remove name any event, so a hook installed on another one can still be removed', () => {
    expect(checkHookEvent('PreCompact', true)).toBeNull();
  });
});

describe('friendlyParseError', () => {
  const help = 'Options:\n  --since <days>       How far back\n  --out <file>         Where\n';

  it('names the placeholder the help uses for a missing value', () => {
    expect(friendlyParseError("Option '--since <value>' argument missing", help)).toBe('--since needs a value: --since <days>');
    expect(friendlyParseError("Option '-o, --out <value>' argument missing", help)).toBe('--out needs a value: --out <file>');
  });

  it('falls back to <value> when the help has no placeholder', () => {
    expect(friendlyParseError("Option '--theme <value>' argument missing", undefined)).toBe('--theme needs a value: --theme <value>');
  });

  it("drops Node's advice about -- from unknown-option errors", () => {
    expect(friendlyParseError("Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--nope\"", help)).toBe(
      "Unknown option '--nope'.",
    );
  });
});

describe('help text', () => {
  it('keeps every help line within 100 columns', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/bin.ts'), 'utf8');
    const blocks = [...source.matchAll(/(?:help: |_HELP = |USAGE = )`((?:\\`|[^`])*)`/g)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThan(10);
    const long = blocks.flatMap((block) => block.split('\n')).filter((line) => line.replace(/\\`/g, '`').replace(/\$\{[^}]+\}/g, 'SessionEnd').length > 100);
    expect(long).toEqual([]);
  });
});
