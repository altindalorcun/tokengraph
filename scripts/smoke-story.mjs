// Runs the bundle's story command in a temp home and output folder and checks the PNGs.
// Default: packages/cli/bundle/bin.js. With --packed: also `npm pack` the package, extract the tarball and run
// the shipped layout (bundle/ + assets/ only), which proves asset resolution and that nothing needs node_modules.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packed = process.argv.includes('--packed');

function runStory(label, binJs) {
  const home = mkdtempSync(join(tmpdir(), 'tg-smoke-home-'));
  const out = mkdtempSync(join(tmpdir(), 'tg-smoke-out-'));
  try {
    execFileSync(process.execPath, [binJs, 'story', '--no-qr', '--no-preview', '--out', out, '--handle', 'smoke'], {
      env: { ...process.env, TOKENGRAPH_HOME: home },
      stdio: 'inherit',
    });
    const files = readdirSync(out).filter((name) => name.endsWith('.png'));
    if (files.length !== 3) throw new Error(`${label}: expected 3 PNGs, got ${files.join(', ') || 'none'}`);
    for (const file of files) {
      const bytes = readFileSync(join(out, file));
      if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error(`${label}: ${file} is not a PNG`);
    }
    console.log(`smoke ok (${label}): ${files.join(', ')}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

runStory('source bundle', join(root, 'packages/cli/bundle/bin.js'));

if (packed) {
  const work = mkdtempSync(join(tmpdir(), 'tg-smoke-pack-'));
  try {
    // npm is npm.cmd on Windows, which only runs through a shell; quote the one path that can hold spaces there.
    const windows = process.platform === 'win32';
    const packOut = execFileSync(
      windows ? 'npm.cmd' : 'npm',
      ['pack', '-w', 'tokengraph', '--pack-destination', windows ? `"${work}"` : work, '--json', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8', shell: windows },
    );
    const tarball = JSON.parse(packOut)[0].filename;
    // Relative names with cwd = work: no drive letter or space can confuse tar (present on Windows 10+).
    mkdirSync(join(work, 'extracted'), { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', 'extracted'], { cwd: work });
    const pkgDir = join(work, 'extracted', 'package');
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
      throw new Error(`packed package has runtime dependencies: ${Object.keys(manifest.dependencies).join(', ')}`);
    }
    const fonts = ['mono-400', 'mono-500', 'mono-600', 'sans-400', 'sans-500', 'sans-600', 'sans-700'].map((name) => `assets/fonts/plex-${name}.ttf`);
    const neededFiles = ['bundle/bin.js', 'THIRD-PARTY-NOTICES.md', 'assets/resvg.wasm', 'assets/fonts/OFL.txt', ...fonts];
    for (const needed of neededFiles) {
      if (!existsSync(join(pkgDir, needed))) throw new Error(`packed package is missing ${needed}`);
    }
    runStory('packed tarball', join(pkgDir, 'bundle/bin.js'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
