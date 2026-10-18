// Environment variables that locate agent or tokengraph data. setup-home.ts deletes every one of them so a
// developer's real overrides never reach a test; test-isolation.test.ts checks this list against packages/cli/src.
export const CLEARED_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'CLINE_DIR',
  'CLINE_DATA_DIR',
  'CLINE_SESSION_DATA_DIR',
  'COPILOT_HOME',
  'GOOSE_PATH_ROOT',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'KILO_DB',
  'OPENCODE_DB',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
] as const;
