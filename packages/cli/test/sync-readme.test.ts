import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without types
import { npmReadme } from '../../../scripts/sync-readme.mjs';

const RAW = 'https://raw.githubusercontent.com/altindalorcun/tokengraph/main/';

describe('npmReadme', () => {
  it('makes repo-relative images absolute and leaves everything else alone', () => {
    const input = [
      '![graph](docs/assets/graph-light.svg)',
      '<source srcset="docs/assets/graph-dark.svg">',
      '<img src="docs/assets/graph-light.svg">',
      '[docs](https://example.com/docs/x)',
      'See `docs/product.md`.',
    ].join('\n');
    expect(npmReadme(input, RAW)).toBe(
      [
        `![graph](${RAW}docs/assets/graph-light.svg)`,
        `<source srcset="${RAW}docs/assets/graph-dark.svg">`,
        `<img src="${RAW}docs/assets/graph-light.svg">`,
        '[docs](https://example.com/docs/x)',
        'See `docs/product.md`.',
      ].join('\n'),
    );
  });
});
