// Runs the bundle's story command in a temp home and output folder and checks the PNGs.
// Default: packages/cli/bundle/bin.js. With --packed: also `npm pack` the package, extract the tarball and run
// the shipped layout (bundle/ + assets/ only), which proves asset resolution and that nothing needs node_modules.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
    const packOut = execFileSync('npm', ['pack', '-w', 'tokengraph', '--pack-destination', work, '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    });
    const tarball = join(work, JSON.parse(packOut)[0].filename);
    const extracted = join(work, 'extracted');
    execFileSync('mkdir', ['-p', extracted]);
    execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
    const pkgDir = join(extracted, 'package');
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
      throw new Error(`packed package has runtime dependencies: ${Object.keys(manifest.dependencies).join(', ')}`);
    }
    for (const needed of ['bundle/bin.js', 'assets/resvg.wasm', 'assets/fonts/plex-sans-400.ttf']) {
      if (!existsSync(join(pkgDir, needed))) throw new Error(`packed package is missing ${needed}`);
    }
    runStory('packed tarball', join(pkgDir, 'bundle/bin.js'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
