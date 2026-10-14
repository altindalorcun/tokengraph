// Writes packages/cli/README.md (the npm page) from the root README.md.
// npm renders a package README away from the repo, so repo-relative images must point at GitHub.
//   node scripts/sync-readme.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAW_BASE = 'https://raw.githubusercontent.com/altindalorcun/tokengraph/main/';

/** Rewrites `](docs/…`, `src="docs/…` and `srcset="docs/…` to absolute URLs; nothing else changes. */
export function npmReadme(markdown, repoRawBase) {
  return markdown.replace(/(\]\(|\bsrcset="|\bsrc=")(docs\/)/g, (_match, prefix, path) => `${prefix}${repoRawBase}${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'README.md'), 'utf8');
  writeFileSync(join(root, 'packages/cli/README.md'), npmReadme(source, RAW_BASE));
  console.log('packages/cli/README.md written');
}
