import { describe, expect, it } from 'vitest';
import { rawGistUrl, readmeSnippet } from '../src/readme-snippet.js';

describe('readme snippet', () => {
  it('links raw files without a revision', () => {
    expect(rawGistUrl('octocat', 'abc', 'tokengraph-dark.svg')).toBe('https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-dark.svg');
  });

  it('switches theme with <picture> and links the project', () => {
    const snippet = readmeSnippet('octocat', 'abc');
    expect(snippet).toContain('<a href="https://github.com/altindalorcun/tokengraph">');
    expect(snippet).toContain('media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-dark.svg"');
    expect(snippet).toContain('src="https://gist.githubusercontent.com/octocat/abc/raw/tokengraph-light.svg"');
  });

  it('uses the compact files when asked', () => {
    expect(readmeSnippet('octocat', 'abc', { compact: true })).toContain('tokengraph-compact-dark.svg');
  });
});
