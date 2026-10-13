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

/**
 * Sources the server accepts uploads from. Each is produced by a CLI adapter: uploads are CLI-only,
 * so the leaderboard is not fed by hand-written requests. Add a source together with its adapter.
 */
export const KNOWN_SOURCES = [
  CLAUDE_CODE_SOURCE,
  CODEX_CLI_SOURCE,
  CURSOR_SOURCE,
  GEMINI_CLI_SOURCE,
  CLINE_SOURCE,
  OPENCODE_SOURCE,
] as const;
export type KnownSource = (typeof KNOWN_SOURCES)[number];

export interface AgentEntry {
  /** The source string its adapter would upload under. */
  source: string;
  name: string;
}

/**
 * The agents token-graph reads, in the order the landing page lists them. Every entry has a
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
];

export function isKnownSource(source: string): source is KnownSource {
  return (KNOWN_SOURCES as readonly string[]).includes(source);
}

/** A source's display name from the catalogue; an unknown source id is shown as itself. */
export function agentName(source: string): string {
  return AGENT_CATALOGUE.find((agent) => agent.source === source)?.name ?? source;
}
