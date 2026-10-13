import { readConfig, writeConfig, type GitHubAuth } from '../config.js';
import { ghToken, findGh, hasGistScope } from '../github/auth.js';
import { DeviceFlowError, pollForToken, requestDeviceCode, type DeviceCode } from '../github/device-flow.js';
import { createGitHubClient, GitHubError, type GitHubClient } from '../github/http.js';
import { copyToClipboard } from '../clipboard.js';
import { openUrl } from '../open-url.js';
import { askYesNo } from '../prompt.js';

export interface LoginOptions {
  method: 'auto' | 'gh' | 'device';
  openBrowser: boolean;
}

export interface LoginDeps {
  isTTY: boolean;
  findGh: () => string | null;
  ghToken: (ghPath: string) => Promise<string | null>;
  clientForToken: (token: string) => GitHubClient;
  requestDeviceCode: () => Promise<DeviceCode>;
  pollForToken: (code: DeviceCode) => Promise<{ accessToken: string; scopes: string[] }>;
  ask: (question: string) => Promise<boolean>;
  copy: (text: string) => Promise<boolean>;
  open: (url: string) => void;
  /** Runs the first sync + publish and prints the README snippet. */
  firstPublish: () => Promise<number>;
  /** Offers the hourly schedule (or explains how to get it from an npx run). */
  offerSchedule: () => Promise<void>;
}

const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[22m` : text);

function defaultDeps(): LoginDeps {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    findGh: () => findGh(),
    ghToken: (path) => ghToken(path),
    clientForToken: (token) => createGitHubClient({ token: async () => token }),
    requestDeviceCode: () => requestDeviceCode(),
    pollForToken: (code) => pollForToken(code),
    ask: (question) => askYesNo(question),
    copy: (text) => copyToClipboard(text),
    open: openUrl,
    firstPublish: async () => (await import('./login-finish.js')).firstPublish(),
    offerSchedule: async () => (await import('./login-finish.js')).offerSchedule(),
  };
}

async function tryGh(options: LoginOptions, deps: LoginDeps): Promise<{ auth: GitHubAuth; login: string } | null> {
  const ghPath = deps.findGh();
  if (!ghPath) return null;
  const token = await deps.ghToken(ghPath);
  if (!token) return null;
  let user;
  try {
    user = await deps.clientForToken(token).getUser();
  } catch {
    return null;
  }
  if (!hasGistScope(user.scopes)) {
    if (options.method === 'gh') console.error(`Your GitHub CLI token has no "gist" scope. Run: gh auth refresh -s gist`);
    return null;
  }
  if (options.method !== 'gh' && !(deps.isTTY && (await deps.ask(`Use your GitHub CLI account ${bold(`@${user.login}`)}?`)))) return null;
  return { auth: { kind: 'gh', ghPath }, login: user.login };
}

async function deviceFlow(options: LoginOptions, deps: LoginDeps): Promise<{ auth: GitHubAuth; login: string }> {
  const code = await deps.requestDeviceCode();
  const copied = await deps.copy(code.userCode);
  console.log('');
  console.log(`  Your one-time code:  ${bold(code.userCode)}${copied ? '   (copied)' : ''}`);
  console.log(`  Enter it at:         ${code.verificationUri}`);
  console.log('');
  if (options.openBrowser && deps.isTTY) deps.open(code.verificationUri);
  console.log('Waiting for you to approve tokengraph on GitHub…');
  const { accessToken } = await deps.pollForToken(code);
  const user = await deps.clientForToken(accessToken).getUser();
  if (!hasGistScope(user.scopes)) throw new DeviceFlowError('failed', 'the approved token cannot write gists');
  return { auth: { kind: 'token', token: accessToken }, login: user.login };
}

export async function runLogin(options: LoginOptions, overrides: Partial<LoginDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  let account: { auth: GitHubAuth; login: string } | null = null;
  try {
    if (options.method !== 'device') account = await tryGh(options, deps);
    if (!account && options.method === 'gh') {
      console.error('Could not use the GitHub CLI. Install it and run `gh auth login`, or run `tokengraph login` without --gh.');
      return 1;
    }
    account ??= await deviceFlow(options, deps);
  } catch (error) {
    if (error instanceof DeviceFlowError || error instanceof GitHubError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const config = await readConfig();
  await writeConfig({ ...config, github: { login: account.login, auth: account.auth } });
  console.log(`\n✓ Logged in as ${bold(`@${account.login}`)}${account.auth.kind === 'gh' ? ' (via the GitHub CLI)' : ''}\n`);

  const code = await deps.firstPublish();
  if (code === 0 && deps.isTTY) await deps.offerSchedule();
  return code;
}
