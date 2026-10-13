import { createInterface } from 'node:readline/promises';

export interface PromptIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/** A [Y/n] question. Without a terminal it never waits: it returns the default. */
export async function askYesNo(question: string, options: { defaultYes?: boolean; io?: PromptIO } = {}): Promise<boolean> {
  const defaultYes = options.defaultYes ?? true;
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  if (!io.input.isTTY) return defaultYes;
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const answer = (await rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
