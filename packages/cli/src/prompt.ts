import { createInterface } from 'node:readline/promises';

export interface PromptIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/**
 * A [Y/n] question. Without a terminal it never waits: it returns the default. In a terminal, closing the
 * prompt without an answer (Ctrl+D, Ctrl+C) means no: an abort must never start a server or install a schedule.
 */
export async function askYesNo(question: string, options: { defaultYes?: boolean; io?: PromptIO } = {}): Promise<boolean> {
  const defaultYes = options.defaultYes ?? true;
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  if (!io.input.isTTY) return defaultYes;
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    // EOF / Ctrl+D / Ctrl+C closes the interface without an answer; that must not leave the promise pending.
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    const raw = await Promise.race([rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `), closed]);
    if (raw === null) return false;
    const answer = raw.trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
