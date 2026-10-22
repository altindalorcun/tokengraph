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

/** One line of free text, trimmed. Without a terminal, or when the prompt is closed without an answer, it returns ''. */
export async function askText(question: string, options: { io?: PromptIO } = {}): Promise<string> {
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  if (!io.input.isTTY) return '';
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    const raw = await Promise.race([rl.question(`${question} `), closed]);
    return raw === null ? '' : raw.trim();
  } finally {
    rl.close();
  }
}

/**
 * A numbered list; Enter takes the default and an answer outside the list asks again. Without a terminal it
 * returns the default. Closing the prompt without an answer (Ctrl+D, Ctrl+C) returns null, so the caller stops.
 */
export async function askChoice(
  question: string,
  choices: readonly string[],
  options: { defaultIndex?: number; io?: PromptIO } = {},
): Promise<number | null> {
  const defaultIndex = options.defaultIndex ?? 0;
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  if (!io.input.isTTY) return defaultIndex;
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    io.output.write(`${question}\n${choices.map((choice, index) => `    ${index + 1}) ${choice}`).join('\n')}\n`);
    for (;;) {
      const raw = await Promise.race([rl.question(`  Choose 1-${choices.length} [${defaultIndex + 1}]: `), closed]);
      if (raw === null) return null;
      const answer = raw.trim();
      if (answer === '') return defaultIndex;
      const picked = Number(answer);
      if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length) return picked - 1;
    }
  } finally {
    rl.close();
  }
}
