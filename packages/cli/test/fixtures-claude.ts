import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ClaudeMessage {
  id: string;
  timestamp: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

/** Writes one Claude Code transcript (`<claudeDir>/projects/<project>/s.jsonl`) holding the given assistant messages. */
export async function writeClaudeTranscript(claudeDir: string, messages: ClaudeMessage[], project = 'p'): Promise<void> {
  const dir = join(claudeDir, 'projects', project);
  await mkdir(dir, { recursive: true });
  const lines = messages.map((message) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: message.timestamp,
      message: {
        id: message.id,
        model: message.model ?? 'claude-sonnet-5',
        usage: {
          input_tokens: message.inputTokens,
          output_tokens: message.outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  );
  await writeFile(join(dir, 's.jsonl'), lines.join('\n'));
}
