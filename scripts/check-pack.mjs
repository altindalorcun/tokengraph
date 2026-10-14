// Fails when the npm tarball ships anything unexpected or grows past the budget.
import { execFileSync } from 'node:child_process';

const MAX_UNPACKED = 6_000_000;
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'bundle/bin.js', 'assets/resvg.wasm'];
const ALLOWED = ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'bundle/bin.js'];

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '-w', 'tokengraph'], { encoding: 'utf8', shell: process.platform === 'win32' });
// The prepack lifecycle script prints to stdout before npm's JSON array, so parse from the array's own first line.
const start = /^\[\s*$/m.exec(output)?.index;
if (start === undefined) {
  console.error(`could not find npm's JSON output:\n${output}`);
  process.exit(1);
}
const [pack] = JSON.parse(output.slice(start));
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
