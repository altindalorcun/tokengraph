// Fails when the npm tarball ships anything unexpected or grows past the budget.
import { execFileSync } from 'node:child_process';

const MAX_UNPACKED = 6_000_000;
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'bundle/bin.js', 'assets/resvg.wasm'];
const ALLOWED = ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'bundle/bin.js'];

const shell = process.platform === 'win32';
// Build and sync the README explicitly, then pack with --ignore-scripts so prepack does not
// rebuild or rewrite anything and npm's stdout is pure JSON.
execFileSync('npm', ['run', 'build', '-w', 'tokengraph'], { stdio: 'inherit', shell });
execFileSync(process.execPath, ['scripts/sync-readme.mjs'], { stdio: 'inherit' });
const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '-w', 'tokengraph'], { encoding: 'utf8', shell });
let pack;
try {
  [pack] = JSON.parse(output);
} catch (error) {
  console.error(`could not parse npm's JSON output (${error.message}):\n${output}`);
  process.exit(1);
}
const files = pack.files.map((file) => file.path).sort();
const allowed = (path) => ALLOWED.includes(path) || path.startsWith('assets/');
const unexpected = files.filter((path) => !allowed(path));
const missing = REQUIRED.filter((path) => !files.includes(path));
const problems = [];
if (unexpected.length) problems.push(`unexpected files: ${unexpected.join(', ')}`);
if (missing.length) problems.push(`missing files: ${missing.join(', ')}`);
if (pack.unpackedSize > MAX_UNPACKED) problems.push(`unpacked size ${pack.unpackedSize} > ${MAX_UNPACKED}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`pack ok: ${files.length} files, ${(pack.unpackedSize / 1e6).toFixed(2)} MB unpacked`);
