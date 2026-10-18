import {
  AGENT_CATALOGUE,
  CLINE_SOURCE,
  CODEX_CLI_SOURCE,
  COPILOT_CLI_SOURCE,
  CURSOR_SOURCE,
  GEMINI_CLI_SOURCE,
  isKnownSource,
  KILO_SOURCE,
  KNOWN_SOURCES,
  OPENCODE_SOURCE,
  PI_SOURCE,
  QWEN_CODE_SOURCE,
} from '@tokengraph/core';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';

describe('known sources', () => {
  it('knows the source Claude Code usage is recorded under', () => {
    expect(KNOWN_SOURCES).toContain(createClaudeCodeAdapter().name);
  });

  it('knows Codex CLI', () => {
    expect(CODEX_CLI_SOURCE).toBe('codex-cli');
    expect(KNOWN_SOURCES).toContain(CODEX_CLI_SOURCE);
  });

  it('knows Cursor', () => {
    expect(CURSOR_SOURCE).toBe('cursor');
    expect(KNOWN_SOURCES).toContain(CURSOR_SOURCE);
  });

  it('knows Gemini CLI, Cline and OpenCode', () => {
    expect(GEMINI_CLI_SOURCE).toBe('gemini-cli');
    expect(CLINE_SOURCE).toBe('cline');
    expect(OPENCODE_SOURCE).toBe('opencode');
    for (const source of [GEMINI_CLI_SOURCE, CLINE_SOURCE, OPENCODE_SOURCE]) {
      expect(KNOWN_SOURCES).toContain(source);
    }
    expect(isKnownSource('aider')).toBe(false);
    // Every catalogue entry has a shipped adapter, so every one is an accepted source.
    for (const agent of AGENT_CATALOGUE) expect(isKnownSource(agent.source)).toBe(true);
    expect(AGENT_CATALOGUE.map((agent) => agent.source)).toEqual([
      'claude-code', 'codex-cli', 'gemini-cli', 'cursor', 'cline', 'opencode', 'kilo', 'copilot-cli', 'pi', 'qwen-code',
    ]);
  });

  it('knows Kilo CLI', () => {
    expect(KILO_SOURCE).toBe('kilo');
    expect(KNOWN_SOURCES).toContain(KILO_SOURCE);
    expect(AGENT_CATALOGUE.find((agent) => agent.source === KILO_SOURCE)?.name).toBe('Kilo CLI');
  });

  it('knows Copilot CLI', () => {
    expect(COPILOT_CLI_SOURCE).toBe('copilot-cli');
    expect(KNOWN_SOURCES).toContain(COPILOT_CLI_SOURCE);
    expect(AGENT_CATALOGUE.find((agent) => agent.source === COPILOT_CLI_SOURCE)?.name).toBe('Copilot CLI');
  });

  it('knows pi', () => {
    expect(PI_SOURCE).toBe('pi');
    expect(KNOWN_SOURCES).toContain(PI_SOURCE);
    expect(AGENT_CATALOGUE.find((agent) => agent.source === PI_SOURCE)?.name).toBe('pi');
  });

  it('knows Qwen Code', () => {
    expect(QWEN_CODE_SOURCE).toBe('qwen-code');
    expect(KNOWN_SOURCES).toContain(QWEN_CODE_SOURCE);
    expect(AGENT_CATALOGUE.find((agent) => agent.source === QWEN_CODE_SOURCE)?.name).toBe('Qwen Code');
  });
});
