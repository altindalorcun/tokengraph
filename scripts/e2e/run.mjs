#!/usr/bin/env node
// Real-agent end-to-end check. See README.md in this folder.
//
//   node scripts/e2e/run.mjs [agent...] [--keep] [--out result.json] [--timeout seconds]
//
// For every agent: install the pinned version into scripts/e2e/.cache, start fake-llm, make a throwaway HOME, point the
// real agent at the fake server, run three scenarios per protocol (one-shot, resume, tool loop), then run tokengraph
// (`sync --local`, `export --format json`) from this checkout's build with the same HOME and compare per-model counters
// with the fake server's log. Plain Node ESM, no dependencies.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir, platform as osPlatform, arch as osArch } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CACHE = join(HERE, '.cache');
const IS_WIN = osPlatform() === 'win32';
const FAKE = join(HERE, 'fake-llm.mjs');
const TG_BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');

// ---------------------------------------------------------------------------------------------------------------------
// Pinned versions live in versions.json (the CI cache key hashes that file).
// ---------------------------------------------------------------------------------------------------------------------
const VERSIONS = JSON.parse(readFileSync(join(HERE, 'versions.json'), 'utf8'));

const PROMPTS = {
  oneshot: 'Say hello in one short sentence.',
  resume: 'Now say goodbye in one short sentence.',
  tools: 'Open README.md in the current folder and tell me its first line.',
};

// ---------------------------------------------------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------------------------------------------------
/** Quote one argument for cmd.exe (needed because a `.cmd` shim can only be started through a shell on Windows). */
function cmdQuote(arg) {
  const text = String(arg);
  if (text !== '' && !/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Kill a child and everything it started (the npm launchers start a native binary, which may start more). */
function killTree(child) {
  if (child.pid == null) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

/**
 * A package bin Windows cannot start by itself: a .js/.mjs/.cjs file, or an extensionless script with a node shebang
 * (cline's `bin/cline`, used when npm 10 made no shim for it).
 */
function isNodeScript(command) {
  if (/\.(c|m)?js$/i.test(command)) return true;
  if (parse(command).ext !== '' || !existsSync(command)) return false;
  try {
    return /^#!.*\bnode\b/.test(readFileSync(command, 'utf8').slice(0, 200));
  } catch {
    return false;
  }
}

function exec(command, args, { env, cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((done) => {
    // Windows: node refuses to start a .cmd/.bat without a shell (EINVAL since the 2024 security fix), and a shell needs
    // the command line quoted by hand. POSIX: own process group, so a timeout can kill the whole tree.
    const shim = IS_WIN && /\.(cmd|bat)$/i.test(command);
    if (IS_WIN && isNodeScript(command)) { args = [command, ...args]; command = process.execPath; } // bin entry without a shim
    const child = shim
      ? spawn([command, ...args].map(cmdQuote).join(' '), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true })
      : spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); done({ code: -1, stdout, stderr: stderr + String(error), timedOut }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!IS_WIN) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ } }
      done({ code: timedOut ? -2 : code, stdout, stderr, timedOut });
    });
  });
}

const tail = (text, n = 1200) => (text.length > n ? `...${text.slice(-n)}` : text);

/** Minimal environment: nothing inherited except what a process needs to start. Never a real provider key. */
function baseEnv(home) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: 'en_US.UTF-8',
  };
  if (IS_WIN) {
    // process.env is case-insensitive on Windows, so each name is listed once. HOMEDRIVE/HOMEPATH are what some tools
    // read when USERPROFILE is missing; they must point into the throwaway home too.
    for (const key of ['SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'COMPUTERNAME']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.HOMEDRIVE = parse(home).root.replace(/[\\/]$/, '');
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
  }
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]) {
    mkdirSync(dir, { recursive: true });
  }
  return env;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const readJsonl = (file) =>
  (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).map((line) => JSON.parse(line));

// ---------------------------------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------------------------------
async function installNpm(spec) {
  const prefix = join(CACHE, `${spec.bin}-${spec.version}`);
  const binDir = join(prefix, 'node_modules', '.bin');
  const bin = join(binDir, IS_WIN ? `${spec.bin}.cmd` : spec.bin);
  if (existsSync(bin)) return bin;
  // npm 10 (the one bundled with Node 22) leaves out the .bin link of some packages (cline 3.0.73 on Linux); the bin target
  // named in the package's own manifest is the same file.
  const manifestBin = () => {
    try {
      const manifest = JSON.parse(readFileSync(join(prefix, 'node_modules', ...spec.pkg.split('/'), 'package.json'), 'utf8'));
      const target = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[spec.bin];
      const file = target ? resolve(prefix, 'node_modules', ...spec.pkg.split('/'), target) : null;
      return file && existsSync(file) ? file : null;
    } catch { return null; }
  };
  const cached = manifestBin();
  if (cached) return cached;
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, 'package.json'), '{"private":true}\n');
  const npm = IS_WIN ? 'npm.cmd' : 'npm';
  const result = await exec(npm, ['install', '--prefix', prefix, `${spec.pkg}@${spec.version}`, '--no-audit', '--no-fund', '--loglevel=error'], {
    env: { ...process.env, npm_config_update_notifier: 'false' },
    timeoutMs: 600_000,
  });
  if (result.code === 0 && existsSync(bin)) return bin;
  const fallback = result.code === 0 ? manifestBin() : null;
  if (!fallback) throw new Error(`npm install ${spec.pkg}@${spec.version} failed (exit ${result.code}, ${existsSync(bin) ? 'bin present' : `no ${bin}`}): ${tail(result.stderr || result.stdout)}`);
  return fallback;
}

function gooseAsset() {
  const a = osArch();
  if (osPlatform() === 'darwin') return a === 'arm64' ? 'goose-aarch64-apple-darwin.tar.gz' : 'goose-x86_64-apple-darwin.tar.gz';
  if (osPlatform() === 'linux') return a === 'arm64' ? 'goose-aarch64-unknown-linux-gnu.tar.gz' : 'goose-x86_64-unknown-linux-gnu.tar.gz';
  if (IS_WIN) return 'goose-x86_64-pc-windows-msvc.zip';
  throw new Error(`no Goose release for ${osPlatform()}/${a}`);
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Unpack the Goose archive. macOS (bsdtar) and Linux (GNU tar) unpack the .tar.gz with `tar`. The Windows release is a
 * .zip: Windows 10+ ships bsdtar as System32\tar.exe, which reads zip. It is called by full path because Git for Windows
 * puts a GNU tar first on PATH on GitHub runners, which cannot read zip. PowerShell's Expand-Archive is the fallback.
 * Relative names with `cwd` keep a `C:` out of GNU tar's host:path parsing.
 */
function unpack(archive, dir) {
  const name = basename(archive);
  const attempts = IS_WIN
    ? [
      [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', name]],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${name}' -DestinationPath '.' -Force`]],
    ]
    : [['tar', ['-xf', name]]];
  const errors = [];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return;
    errors.push(`${cmd}: ${r.error ?? r.stderr}`);
  }
  throw new Error(`unpack ${name}: ${errors.join(' | ')}`);
}

async function installGoose(spec) {
  const dir = join(CACHE, `goose-${spec.version}`);
  const exe = IS_WIN ? 'goose.exe' : 'goose';
  const existing = existsSync(dir) ? findFile(dir, exe) : null;
  if (existing) return existing;
  mkdirSync(dir, { recursive: true });
  const asset = gooseAsset();
  const url = `https://github.com/block/goose/releases/download/${spec.release}/${asset}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
  const archive = join(dir, asset);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  unpack(archive, dir);
  const found = findFile(dir, exe);
  if (!found) throw new Error(`${exe} not found in ${asset}`);
  if (!IS_WIN) chmodSync(found, 0o755);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------------------------------------------------
function startFake(logFile) {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [FAKE, '--port', '0', '--log', logFile, '--exit-on-stdin-close'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('fake-llm did not start')), 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /READY (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolveStart({
          port: Number(m[1]),
          async setToolTurns(n) {
            await fetch(`http://127.0.0.1:${m[1]}/__control`, { method: 'POST', body: JSON.stringify({ toolTurns: n }) });
          },
          stop() { try { child.stdin.end(); } catch { /* already gone */ } child.kill(); },
        });
      }
    });
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Agent drivers
//
// A driver has: id (the tokengraph source), install(), skip (reason, no run), and variants[]. A variant is one protocol
// the agent supports: { protocol, model, ... }. `prepare(ctx)` runs once per agent (config files); each variant has
// `command(ctx, scenario, state)` giving { args, env } for a scenario ('oneshot' | 'resume' | 'tools'), where `state` carries
// what earlier runs of that variant produced (for agents that need an explicit session id to resume).
// ctx: { home, port, base, env (sandbox env), work (cwd) }
// ---------------------------------------------------------------------------------------------------------------------
const fakeModel = (protocol) => ({ chat: 'fake-chat', responses: 'fake-resp', anthropic: 'fake-anth', gemini: 'fake-gemini' })[protocol];

/** opencode and kilo share one config shape; only the env var that carries it differs. */
function opencodeFamily({ id, bin, configVar, extraEnv, runVerb = 'run' }) {
  const providerName = { chat: 'fkchat', responses: 'fkresp', anthropic: 'fkanth' };
  const npm = { chat: '@ai-sdk/openai-compatible', responses: '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic' };
  const config = (ctx) => {
    const provider = {};
    for (const p of ['chat', 'responses', 'anthropic']) {
      provider[providerName[p]] = {
        npm: npm[p],
        name: providerName[p],
        options: { baseURL: `${ctx.base}/v1`, apiKey: 'fake-key' },
        models: { [fakeModel(p)]: { name: fakeModel(p), limit: { context: 100000, output: 8000 } } },
      };
    }
    return { autoupdate: false, share: 'disabled', enabled_providers: Object.values(providerName), provider };
  };
  return {
    id,
    install: () => installNpm(VERSIONS[id]),
    variants: ['chat', 'responses', 'anthropic'].map((protocol) => ({
      protocol,
      model: fakeModel(protocol),
      command: (ctx, scenario) => ({
        args: [runVerb, '-m', `${providerName[protocol]}/${fakeModel(protocol)}`, '--format', 'json', '--auto', ...(scenario === 'resume' ? ['-c'] : []), PROMPTS[scenario]],
        env: { [configVar]: JSON.stringify(config(ctx)), ...extraEnv },
      }),
    })),
  };
}

/** Claude Code on Windows runs its shell tool through Git Bash; GitHub's Windows runners have Git for Windows here. */
function gitBashEnv() {
  if (!IS_WIN) return {};
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  const found = candidates.find((c) => c && existsSync(c));
  return found ? { CLAUDE_CODE_GIT_BASH_PATH: found } : {};
}

const DRIVERS = {
  'claude-code': {
    id: 'claude-code',
    install: () => installNpm(VERSIONS['claude-code']),
    dataEnv: (home) => ({ CLAUDE_CONFIG_DIR: join(home, '.claude') }),
    variants: [{
      protocol: 'anthropic',
      model: fakeModel('anthropic'),
      command: (ctx, scenario) => ({
        args: ['-p', PROMPTS[scenario], '--model', fakeModel('anthropic'), '--output-format', 'json', '--dangerously-skip-permissions', ...(scenario === 'resume' ? ['-c'] : [])],
        env: {
          ANTHROPIC_BASE_URL: ctx.base,
          ANTHROPIC_API_KEY: 'sk-ant-fake-key-for-e2e',
          DISABLE_TELEMETRY: '1',
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...gitBashEnv(),
        },
      }),
    }],
  },

  'codex-cli': {
    id: 'codex-cli',
    install: () => installNpm(VERSIONS['codex-cli']),
    dataEnv: (home) => ({ CODEX_HOME: join(home, '.codex') }),
    prepare(ctx) {
      mkdirSync(join(ctx.home, '.codex'), { recursive: true });
      writeText(join(ctx.home, '.codex', 'config.toml'), [
        'model = "fake-resp"',
        'model_provider = "fake"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'check_for_update_on_startup = false',
        '',
        '[analytics]',
        'enabled = false',
        '',
        '[feedback]',
        'enabled = false',
        '',
        '[model_providers.fake]',
        'name = "fake"',
        `base_url = "${ctx.base}/v1"`,
        'env_key = "FAKE_KEY"',
        'wire_api = "responses"',
        'supports_websockets = false',
        '',
      ].join('\n'));
    },
    variants: [{
      protocol: 'responses',
      model: fakeModel('responses'),
      command: (ctx, scenario) => ({
        args: scenario === 'resume'
          ? ['exec', 'resume', '--last', '--skip-git-repo-check', '--json', '--dangerously-bypass-approvals-and-sandbox', PROMPTS[scenario]]
          : ['exec', '--skip-git-repo-check', '--json', '--dangerously-bypass-approvals-and-sandbox', PROMPTS[scenario]],
        env: { FAKE_KEY: 'fake-key' },
      }),
    }],
  },

  'gemini-cli': {
    id: 'gemini-cli',
    install: () => installNpm(VERSIONS['gemini-cli']),
    dataEnv: (home) => ({ GEMINI_CLI_HOME: home }),
    prepare(ctx) {
      writeJson(join(ctx.home, '.gemini', 'settings.json'), {
        security: { auth: { selectedType: 'gemini-api-key' } },
        general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
        privacy: { usageStatisticsEnabled: false },
        telemetry: { enabled: false },
      });
    },
    variants: [{
      protocol: 'gemini',
      model: fakeModel('gemini'),
      command: (ctx, scenario) => ({
        args: ['-p', PROMPTS[scenario], '-m', fakeModel('gemini'), '--yolo', '-o', 'json', ...(scenario === 'resume' ? ['--resume', 'latest'] : [])],
        env: { GEMINI_API_KEY: 'fake-key', GOOGLE_GEMINI_BASE_URL: ctx.base, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      }),
    }],
  },

  cline: {
    id: 'cline',
    install: () => installNpm(VERSIONS.cline),
    dataEnv: (home) => ({ CLINE_DATA_DIR: join(home, '.cline', 'data') }),
    // Provider ids: openai (compatible, chat), openai-native (responses), anthropic.
    async prepare(ctx, bin) {
      const auth = async (provider, model, url) => {
        const r = await exec(bin, ['auth', '-p', provider, '-k', 'fake-key', '-m', model, '-b', url], { env: ctx.env, cwd: ctx.work });
        if (r.code !== 0) throw new Error(`cline auth ${provider}: ${tail(r.stderr || r.stdout)}`);
      };
      await auth('openai', fakeModel('chat'), `${ctx.base}/v1`);
      await auth('openai-native', fakeModel('responses'), ctx.base);
      const file = join(ctx.env.CLINE_DATA_DIR, 'settings', 'providers.json');
      const current = JSON.parse(readFileSync(file, 'utf8'));
      current.providers.anthropic = {
        settings: { provider: 'anthropic', apiKey: 'fake-key', model: fakeModel('anthropic'), baseUrl: ctx.base },
        updatedAt: '2026-10-20T00:00:00Z',
        tokenSource: 'manual',
      };
      writeJson(file, current);
    },
    variants: [['chat', 'openai'], ['responses', 'openai-native'], ['anthropic', 'anthropic']].map(([protocol, provider]) => ({
      protocol,
      model: fakeModel(protocol),
      // `cline --id <session> --json` exits with "JSON output mode requires a prompt argument or piped stdin (interactive mode is
      // unsupported)" in 3.0.73 whatever way the prompt is given, so a headless resume cannot be driven.
      noResume: 'cline 3.0.73 cannot resume a session headlessly: `--id <session> --json "prompt"` fails with "JSON output mode requires a prompt argument or piped stdin"',
      command: (ctx, scenario) => ({
        args: ['-P', provider, '-m', fakeModel(protocol), '--json', '-y', PROMPTS[scenario]],
        env: {},
      }),
    })),
  },

  opencode: opencodeFamily({
    id: 'opencode',
    bin: 'opencode',
    configVar: 'OPENCODE_CONFIG_CONTENT',
    extraEnv: { OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' },
  }),
  kilo: opencodeFamily({
    id: 'kilo',
    bin: 'kilo',
    configVar: 'KILO_CONFIG_CONTENT',
    extraEnv: { KILO_TELEMETRY_LEVEL: 'off', OPENCODE_DISABLE_MODELS_FETCH: '1' },
  }),

  'copilot-cli': {
    id: 'copilot-cli',
    install: () => installNpm(VERSIONS['copilot-cli']),
    dataEnv: (home) => ({ COPILOT_HOME: join(home, '.copilot') }),
    prepare(ctx) { mkdirSync(join(ctx.home, '.copilot'), { recursive: true }); },
    variants: [
      { protocol: 'chat', type: 'openai', wire: 'completions', v1: true },
      { protocol: 'responses', type: 'openai', wire: 'responses', v1: true },
      { protocol: 'anthropic', type: 'anthropic', wire: undefined, v1: false },
    ].map(({ protocol, type, wire, v1 }) => ({
      protocol,
      model: fakeModel(protocol),
      command: (ctx, scenario) => ({
        args: ['-p', PROMPTS[scenario], '--allow-all-tools', '--no-auto-update', '--output-format', 'json', ...(scenario === 'resume' ? ['--continue'] : [])],
        env: {
          COPILOT_OFFLINE: 'true',
          COPILOT_ALLOW_ALL: 'true',
          COPILOT_PROVIDER_BASE_URL: v1 ? `${ctx.base}/v1` : ctx.base,
          COPILOT_PROVIDER_TYPE: type,
          COPILOT_PROVIDER_API_KEY: 'fake-key',
          COPILOT_MODEL: fakeModel(protocol),
          ...(wire ? { COPILOT_PROVIDER_WIRE_API: wire } : {}),
        },
      }),
    })),
  },

  pi: {
    id: 'pi',
    install: () => installNpm(VERSIONS.pi),
    dataEnv: (home) => ({ PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }),
    prepare(ctx) {
      const api = { chat: 'openai-completions', responses: 'openai-responses', anthropic: 'anthropic-messages' };
      const providers = {};
      for (const p of ['chat', 'responses', 'anthropic']) {
        providers[`fk${p}`] = {
          baseUrl: p === 'anthropic' ? ctx.base : `${ctx.base}/v1`,
          api: api[p],
          apiKey: 'fake-key',
          models: [{ id: fakeModel(p), name: fakeModel(p), reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        };
      }
      writeJson(join(ctx.home, '.pi', 'agent', 'models.json'), { providers });
    },
    variants: ['chat', 'responses', 'anthropic'].map((protocol) => ({
      protocol,
      model: fakeModel(protocol),
      command: (ctx, scenario) => ({
        args: ['--model', `fk${protocol}/${fakeModel(protocol)}`, ...(scenario === 'resume' ? ['-c'] : []), '-p', PROMPTS[scenario]],
        env: {},
      }),
    })),
  },

  'qwen-code': {
    id: 'qwen-code',
    install: () => installNpm(VERSIONS['qwen-code']),
    dataEnv: (home) => ({ QWEN_HOME: join(home, '.qwen') }),
    prepare(ctx) {
      writeJson(join(ctx.home, '.qwen', 'settings.json'), {
        security: { auth: { selectedType: 'openai' } },
        telemetry: { enabled: false },
        general: { enableAutoUpdate: false },
      });
    },
    variants: [{
      protocol: 'chat',
      model: fakeModel('chat'),
      command: (ctx, scenario) => ({
        args: ['--yolo', '-o', 'json', ...(scenario === 'resume' ? ['-c'] : []), PROMPTS[scenario]],
        env: { OPENAI_API_KEY: 'fake-key', OPENAI_BASE_URL: `${ctx.base}/v1`, OPENAI_MODEL: fakeModel('chat'), QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
      }),
    }],
  },

  goose: {
    id: 'goose',
    install: () => installGoose(VERSIONS.goose),
    // macOS/Linux: HOME alone relocates Goose (default data dir); on Windows the documented root variable is the reliable way.
    dataEnv: (home) => (IS_WIN ? { GOOSE_PATH_ROOT: join(home, 'AppData', 'Roaming', 'Block', 'goose') } : {}),
    variants: [
      { protocol: 'chat', model: fakeModel('chat'), env: (ctx) => ({ GOOSE_PROVIDER: 'openai', OPENAI_HOST: ctx.base, OPENAI_API_KEY: 'fake-key' }) },
      // Goose picks the Responses API from the model name; gpt-5.4 is one it accepts.
      { protocol: 'responses', model: 'gpt-5.4', env: (ctx) => ({ GOOSE_PROVIDER: 'openai', OPENAI_HOST: ctx.base, OPENAI_API_KEY: 'fake-key' }) },
      { protocol: 'anthropic', model: fakeModel('anthropic'), env: (ctx) => ({ GOOSE_PROVIDER: 'anthropic', ANTHROPIC_HOST: ctx.base, ANTHROPIC_API_KEY: 'fake-key' }) },
    ].map(({ protocol, model, env }) => ({
      protocol,
      model,
      command: (ctx, scenario) => {
        const name = `e2e-${protocol}-main`;
        const args = scenario === 'resume'
          ? ['run', '-r', '-n', name, '-t', PROMPTS[scenario]]
          : scenario === 'oneshot'
            ? ['run', '-n', name, '-t', PROMPTS[scenario]]
            : ['run', '-n', `e2e-${protocol}-tools`, '-t', PROMPTS[scenario]];
        return { args, env: { ...env(ctx), GOOSE_MODEL: model, GOOSE_MODE: 'auto', GOOSE_TELEMETRY_OFF: '1', GOOSE_DISABLE_KEYRING: '1' } };
      },
    })),
  },

  cursor: {
    id: 'cursor',
    skip: 'Cursor has no endpoint a fake LLM server can stand in for: the agent speaks a private, account-bound protobuf API and the model runs on Cursor servers. Its adapter is checked from committed real samples and hook payloads instead.',
  },
};

const ALL_AGENTS = Object.keys(DRIVERS);

// ---------------------------------------------------------------------------------------------------------------------
// Documented differences between what the fake server returned and what tokengraph counts.
//
// A rule is { id, doc, describe, applies({agent, protocol}), adjust(expected, ctx) } and rewrites the *expected* counters of
// one (agent, model) group before comparing, with `doc` naming the sentence in docs/agents/ that justifies it. Anything
// not covered by a rule is a FAIL.
// ---------------------------------------------------------------------------------------------------------------------
import { RULES } from './rules.mjs';

// ---------------------------------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------------------------------
const COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a, b) => { for (const k of COUNTERS) a[k] += b[k] ?? 0; return a; };

/** Per-model sums of the server's normalized (exclusive) counters over every completion that carried usage. */
function serverTotals(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (e.status !== 200 || !e.normalized || e.usage == null) continue;
    const g = groups.get(e.model) ?? { counters: zero(), requests: 0, protocols: new Set(), entries: [] };
    add(g.counters, e.normalized);
    g.requests += 1;
    g.protocols.add(e.protocol);
    g.entries.push(e);
    groups.set(e.model, g);
  }
  return groups;
}

function tokengraphTotals(rows, source) {
  const groups = new Map();
  for (const row of rows) {
    if (row.source !== source) continue;
    const g = groups.get(row.model) ?? zero();
    add(g, { input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens });
    groups.set(row.model, g);
  }
  return groups;
}

function compare(agentId, entries, rows) {
  const server = serverTotals(entries);
  const actual = tokengraphTotals(rows, agentId);
  const models = [...new Set([...server.keys(), ...actual.keys()])].sort();
  const results = [];
  for (const model of models) {
    const s = server.get(model);
    const raw = s ? { ...s.counters } : zero();
    const expected = { ...raw };
    const applied = [];
    if (s) {
      for (const rule of RULES) {
        if (!rule.applies({ agent: agentId, protocols: [...s.protocols], model, entries: s.entries })) continue;
        const note = rule.adjust(expected, { entries: s.entries, raw });
        if (note !== false) applied.push({ id: rule.id, doc: rule.doc, note: typeof note === 'string' ? note : rule.describe });
      }
    }
    const got = actual.get(model) ?? zero();
    const diff = {};
    for (const k of COUNTERS) diff[k] = got[k] - expected[k];
    results.push({
      model,
      requests: s?.requests ?? 0,
      protocols: s ? [...s.protocols] : [],
      server: raw,
      expected,
      tokengraph: got,
      diff,
      rules: applied,
      pass: COUNTERS.every((k) => diff[k] === 0) && Boolean(s),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// One agent
// ---------------------------------------------------------------------------------------------------------------------
async function runAgent(agentId, opts) {
  const driver = DRIVERS[agentId];
  const result = { agent: agentId, version: VERSIONS[agentId]?.version ?? null, status: 'PASS', scenarios: [], models: [], notes: [] };
  if (driver.skip) return { ...result, status: 'SKIP', notes: [driver.skip] };

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `tg-e2e-${agentId}-`)));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  result.home = home;
  const logFile = join(root, 'fake.jsonl');
  let fake;
  try {
    const bin = await driver.install();
    fake = await startFake(logFile);
    const base = `http://127.0.0.1:${fake.port}`;
    const sandbox = { ...baseEnv(home), ...(driver.dataEnv?.(home) ?? {}) };
    const ctx = { home, port: fake.port, base, env: sandbox, work: null };
    ctx.work = join(root, 'work');
    mkdirSync(ctx.work, { recursive: true });
    writeText(join(ctx.work, 'README.md'), '# fake project\n\nFirst line of the readme.\n');
    await driver.prepare?.(ctx, bin);

    for (const variant of driver.variants) {
      const cwd = join(root, 'work', variant.protocol);
      mkdirSync(cwd, { recursive: true });
      writeText(join(cwd, 'README.md'), '# fake project\n\nFirst line of the readme.\n');
      const state = {};
      for (const scenario of ['oneshot', 'resume', 'tools']) {
        if (scenario === 'resume' && variant.noResume) {
          result.scenarios.push({ variant: variant.protocol, scenario, skipped: variant.noResume });
          continue;
        }
        await fake.setToolTurns(scenario === 'tools' ? 2 : 0);
        const before = readJsonl(logFile).filter((e) => e.usage != null).length;
        const { args, env } = variant.command({ ...ctx, work: cwd }, scenario, state);
        const started = Date.now();
        const run = await exec(bin, args, { env: { ...sandbox, ...env }, cwd, timeoutMs: opts.timeoutMs });
        variant.learn?.(scenario, run, state, ctx);
        const after = readJsonl(logFile).filter((e) => e.usage != null).length;
        const row = { variant: variant.protocol, scenario, exit: run.code, requests: after - before, seconds: Math.round((Date.now() - started) / 100) / 10 };
        if (opts.verbose || run.code !== 0 || after === before) row.output = tail(`${run.stderr}\n${run.stdout}`, 1500);
        if (opts.verbose) row.head = run.stdout.slice(0, 1200);
        result.scenarios.push(row);
      }
      await fake.setToolTurns(0);
    }
    fake.stop();
    fake = null;

    // tokengraph, from this checkout's build, in the same sandbox.
    const tgEnv = { ...sandbox, TOKENGRAPH_HOME: join(home, '.tokengraph') };
    const sync = await exec(process.execPath, [TG_BIN, 'sync', '--local'], { env: tgEnv, cwd: root, timeoutMs: 120_000 });
    if (sync.code !== 0) throw new Error(`tokengraph sync --local failed (${sync.code}): ${tail(sync.stderr || sync.stdout)}`);
    const exportFile = join(root, 'export.json');
    const exported = await exec(process.execPath, [TG_BIN, 'export', '--format', 'json', '--out', exportFile], { env: tgEnv, cwd: root, timeoutMs: 60_000 });
    if (exported.code !== 0) throw new Error(`tokengraph export failed: ${tail(exported.stderr || exported.stdout)}`);
    result.syncOutput = tail(sync.stdout, 600);
    const rows = JSON.parse(readFileSync(exportFile, 'utf8')).rows;
    const entries = readJsonl(logFile);
    result.requestsLogged = entries.filter((e) => e.usage != null).length;
    result.requestsWithoutUsage = entries.filter((e) => e.status === 200 && e.normalized && e.usage == null).length;
    result.models = compare(agentId, entries, rows);
    const failedScenarios = result.scenarios.filter((s) => !s.skipped && (s.exit !== 0 || s.requests === 0));
    if (failedScenarios.length) result.notes.push(`${failedScenarios.length} scenario run(s) failed or made no request: ${failedScenarios.map((s) => `${s.variant}/${s.scenario}`).join(', ')}`);
    if (result.models.length === 0) result.status = 'FAIL';
    else if (result.models.some((m) => !m.pass)) result.status = 'FAIL';
    else if (failedScenarios.length) result.status = 'FAIL';
    if (!opts.keep) result.logCopy = entries;
  } catch (error) {
    result.status = 'ERROR';
    result.notes.push(String(error?.message ?? error));
  } finally {
    fake?.stop();
    if (result.status !== 'PASS') {
      // Keep the server's request log of a failing agent next to the result file (CI uploads this folder).
      try {
        mkdirSync(join(CACHE, 'logs'), { recursive: true });
        if (existsSync(logFile)) copyFileSync(logFile, join(CACHE, 'logs', `${agentId}.fake.jsonl`));
      } catch { /* best effort */ }
    }
    if (opts.keep) result.kept = root;
    else {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { agents: [], keep: false, out: join(CACHE, 'result.json'), timeoutMs: 180_000, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') opts.keep = true;
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
    else if (ALL_AGENTS.includes(a)) opts.agents.push(a);
    else { console.error(`unknown agent ${a}; known: ${ALL_AGENTS.join(', ')}`); process.exit(2); }
  }
  if (opts.agents.length === 0) opts.agents = ALL_AGENTS;
  return opts;
}

const pad = (v, n) => String(v).padEnd(n);

function printTable(results) {
  console.log('');
  console.log(`${pad('agent', 13)}${pad('version', 10)}${pad('status', 7)}detail`);
  for (const r of results) {
    const detail = r.status === 'SKIP' ? r.notes[0] : r.status === 'ERROR' ? r.notes[0] : r.models.map((m) => `${m.model}:${m.pass ? 'ok' : 'DIFF'}`).join(' ');
    console.log(`${pad(r.agent, 13)}${pad(r.version ?? '-', 10)}${pad(r.status, 7)}${detail}`);
  }
  for (const r of results) {
    if (r.status === 'SKIP') continue;
    console.log(`\n== ${r.agent} ${r.version ?? ''} ${r.status}`);
    for (const note of r.notes) console.log(`   note: ${note}`);
    for (const s of r.scenarios) console.log(s.skipped ? `   run ${pad(s.variant, 10)}${pad(s.scenario, 8)}skipped: ${s.skipped}` : `   run ${pad(s.variant, 10)}${pad(s.scenario, 8)}exit ${s.exit} requests ${s.requests} (${s.seconds}s)`);
    for (const m of r.models) {
      console.log(`   model ${m.model} [${m.protocols.join(',')}] requests ${m.requests}  ${m.pass ? 'PASS' : 'FAIL'}`);
      for (const k of COUNTERS) {
        const flag = m.diff[k] === 0 ? '' : '  <-- diff';
        console.log(`      ${pad(k, 10)} server ${pad(m.server[k], 8)} expected ${pad(m.expected[k], 8)} tokengraph ${pad(m.tokengraph[k], 8)} diff ${m.diff[k]}${flag}`);
      }
      for (const rule of m.rules) console.log(`      rule ${rule.id}: ${rule.note} (${rule.doc})`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(TG_BIN)) {
    const build = spawnSync(IS_WIN ? 'npx.cmd' : 'npx', ['tsc', '--build'], { cwd: REPO, stdio: 'inherit', shell: IS_WIN });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  mkdirSync(CACHE, { recursive: true });
  const results = [];
  for (const agent of opts.agents) {
    console.log(`>> ${agent}`);
    const r = await runAgent(agent, opts);
    console.log(`<< ${agent} ${r.status}`);
    results.push(r);
  }
  printTable(results);
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify({ platform: osPlatform(), arch: osArch(), node: process.version, date: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\nResult file: ${opts.out}`);
  process.exit(results.some((r) => r.status === 'FAIL' || r.status === 'ERROR') ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
