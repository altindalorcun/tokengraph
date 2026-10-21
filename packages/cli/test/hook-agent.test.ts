import { describe, expect, it } from 'vitest';
import { resolveHookAgent } from '../src/commands/install-hook.js';

describe('resolveHookAgent', () => {
  it('accepts each agent that has a hook', () => {
    expect(resolveHookAgent('claude-code')).toEqual({ agent: 'claude-code' });
    expect(resolveHookAgent('cursor')).toEqual({ agent: 'cursor' });
    expect(resolveHookAgent('codex')).toEqual({ agent: 'codex' });
    expect(resolveHookAgent('gemini-cli')).toEqual({ agent: 'gemini-cli' });
  });

  it('requires --agent instead of assuming Claude Code', () => {
    const result = resolveHookAgent(undefined);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('--agent is required');
    expect((result as { error: string }).error).toContain('install-hook --agent claude-code');
  });

  it('rejects an unknown agent', () => {
    expect((resolveHookAgent('windsurf') as { error: string }).error).toContain('--agent must be claude-code, cursor, codex or gemini-cli');
  });
});
