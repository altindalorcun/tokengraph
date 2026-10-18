import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';

// Started from this package, vitest would skip the root config and its setup file (which keeps tests away from
// the real home directory). Reuse the root config with the repo root as root, so a run here is identical.
export default mergeConfig(rootConfig, defineConfig({ root: fileURLToPath(new URL('../..', import.meta.url)) }));
