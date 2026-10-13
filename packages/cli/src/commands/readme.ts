import { copyToClipboard } from '../clipboard.js';
import { readConfig, writeConfig, type GraphColors } from '../config.js';
import { readmeSnippet } from '../readme-snippet.js';
import { runSync } from './sync.js';

export interface ReadmeOptions {
  compact: boolean;
  colors?: GraphColors;
  copy?: (text: string) => Promise<boolean>;
  republish?: () => Promise<number>;
}

export async function runReadme(options: ReadmeOptions): Promise<number> {
  let config = await readConfig();
  if (!config.github) {
    console.error('Run `tokengraph login` first: the graph lives in a gist on your GitHub account.');
    return 1;
  }
  if (options.colors && options.colors !== (config.graph?.colors ?? 'model')) {
    config = { ...config, graph: { colors: options.colors } };
    await writeConfig(config);
    const code = await (options.republish ?? (() => runSync({ sinceDays: 30, theme: 'light', quiet: true })))();
    if (code !== 0) return code;
    config = await readConfig();
  }
  if (!config.gists?.graph || !config.github) {
    console.error('No graph published yet. Run `tokengraph sync`.');
    return 1;
  }
  const login = config.github.login;
  const snippet = readmeSnippet(login, config.gists.graph, { compact: options.compact });
  const copied = await (options.copy ?? copyToClipboard)(snippet);
  console.log(`\nAdd this to your profile README${copied ? ' (it is on your clipboard)' : ''}:\n`);
  console.log(snippet);
  console.log(`\nYour profile README is the README.md of the repo named after you: https://github.com/${login}/${login}`);
  console.log("(Don't have it yet? Create a public repo named exactly like your username and tick \"Add a README\".)");
  return 0;
}
