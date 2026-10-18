/** The Claude Code adapter's source name. */
export const CLAUDE_CODE_SOURCE = 'claude-code';
/** The Codex CLI adapter's source name. */
export const CODEX_CLI_SOURCE = 'codex-cli';
/** The Cursor adapter's source name. */
export const CURSOR_SOURCE = 'cursor';
/** The Gemini CLI adapter's source name. */
export const GEMINI_CLI_SOURCE = 'gemini-cli';
/** The Cline adapter's source name. */
export const CLINE_SOURCE = 'cline';
/** The OpenCode adapter's source name. */
export const OPENCODE_SOURCE = 'opencode';
/** The Kilo CLI adapter's source name. */
export const KILO_SOURCE = 'kilo';
/** The GitHub Copilot CLI adapter's source name. */
export const COPILOT_CLI_SOURCE = 'copilot-cli';
/** The pi coding agent adapter's source name. */
export const PI_SOURCE = 'pi';
/** The Qwen Code adapter's source name. */
export const QWEN_CODE_SOURCE = 'qwen-code';
/** The Goose adapter's source name. */
export const GOOSE_SOURCE = 'goose';

/**
 * Sources a ledger may hold. Each is produced by a CLI adapter, and the data-gist reader accepts
 * only these. Add a source together with its adapter.
 */
export const KNOWN_SOURCES = [
  CLAUDE_CODE_SOURCE,
  CODEX_CLI_SOURCE,
  CURSOR_SOURCE,
  GEMINI_CLI_SOURCE,
  CLINE_SOURCE,
  OPENCODE_SOURCE,
  KILO_SOURCE,
  COPILOT_CLI_SOURCE,
  PI_SOURCE,
  QWEN_CODE_SOURCE,
  GOOSE_SOURCE,
] as const;
export type KnownSource = (typeof KNOWN_SOURCES)[number];

export interface AgentEntry {
  /** The source string its adapter records usage under. */
  source: string;
  name: string;
}

/**
 * The agents tokengraph reads, in the order the README and the CLI list them. Every entry has a
 * shipped adapter, so its source must be in KNOWN_SOURCES (a test holds this); an agent without
 * an adapter does not belong here.
 */
export const AGENT_CATALOGUE: readonly AgentEntry[] = [
  { source: CLAUDE_CODE_SOURCE, name: 'Claude Code' },
  { source: CODEX_CLI_SOURCE, name: 'Codex CLI' },
  { source: GEMINI_CLI_SOURCE, name: 'Gemini CLI' },
  { source: CURSOR_SOURCE, name: 'Cursor' },
  { source: CLINE_SOURCE, name: 'Cline' },
  { source: OPENCODE_SOURCE, name: 'OpenCode' },
  { source: KILO_SOURCE, name: 'Kilo CLI' },
  { source: COPILOT_CLI_SOURCE, name: 'Copilot CLI' },
  { source: PI_SOURCE, name: 'pi' },
  { source: QWEN_CODE_SOURCE, name: 'Qwen Code' },
  { source: GOOSE_SOURCE, name: 'Goose' },
];

export function isKnownSource(source: string): source is KnownSource {
  return (KNOWN_SOURCES as readonly string[]).includes(source);
}

/** A source's display name from the catalogue; an unknown source id is shown as itself. */
export function agentName(source: string): string {
  return AGENT_CATALOGUE.find((agent) => agent.source === source)?.name ?? source;
}
