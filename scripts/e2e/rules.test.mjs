import { describe, expect, it } from 'vitest';
import { RULES } from './rules.mjs';

const entry = (protocol, n, tools) => ({
  protocol,
  toolNames: tools,
  reasoning: 5 + n,
  normalized: { input: 1000 + n, output: 50 + n, cacheRead: 200 + n, cacheWrite: 0 },
});

describe('rules', () => {
  it('every rule cites a doc line', () => {
    for (const rule of RULES) expect(rule.doc).toMatch(/^docs\/agents\/.+\.md:\d/);
  });

  it('cline subtracts reasoning on chat and responses only', () => {
    const rule = RULES.find((r) => r.id === 'cline-reasoning-subtracted');
    expect(rule.applies({ agent: 'cline', protocols: ['chat'] })).toBe(true);
    expect(rule.applies({ agent: 'cline', protocols: ['anthropic'] })).toBe(false);
    expect(rule.applies({ agent: 'pi', protocols: ['chat'] })).toBe(false);
    const expected = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
    rule.adjust(expected, { entries: [entry('chat', 1, ['read_files']), entry('chat', 2, ['read_files'])] });
    expect(expected.output).toBe(100 - 6 - 7);
  });

  it('opencode leaves out requests that offered no tools', () => {
    const rule = RULES.find((r) => r.id === 'opencode-title-requests');
    const expected = { input: 3006, output: 156, cacheRead: 606, cacheWrite: 0 };
    rule.adjust(expected, { entries: [entry('chat', 1, []), entry('chat', 2, ['read']), entry('chat', 3, ['read'])] });
    expect(expected).toEqual({ input: 2005, output: 105, cacheRead: 405, cacheWrite: 0 });
  });
});
