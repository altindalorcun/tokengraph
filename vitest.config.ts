import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@tokengraph/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    setupFiles: ['packages/cli/test/setup-home.ts'],
    // Windows runners are slow with node:sqlite and real files; a 5s default failed a Goose test at 5.4s there.
    testTimeout: 20_000,
  },
});
