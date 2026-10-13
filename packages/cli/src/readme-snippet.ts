export const PROJECT_URL = 'https://github.com/altindalorcun/tokengraph';
const RAW_BASE = 'https://gist.githubusercontent.com';

/** Without a revision segment the raw URL always serves the gist's latest file. */
export function rawGistUrl(login: string, gistId: string, file: string): string {
  return `${RAW_BASE}/${login}/${gistId}/raw/${file}`;
}

export function readmeSnippet(login: string, gistId: string, options: { compact?: boolean } = {}): string {
  const prefix = options.compact ? 'tokengraph-compact' : 'tokengraph';
  return [
    `<a href="${PROJECT_URL}">`,
    '  <picture>',
    `    <source media="(prefers-color-scheme: dark)" srcset="${rawGistUrl(login, gistId, `${prefix}-dark.svg`)}">`,
    `    <img alt="My AI coding token usage, made with tokengraph" src="${rawGistUrl(login, gistId, `${prefix}-light.svg`)}">`,
    '  </picture>',
    '</a>',
  ].join('\n');
}
