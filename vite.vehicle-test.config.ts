import { defineConfig, mergeConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import base from './vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: 'node_modules/.vite-kannon-vehicle-test',
  server: { port: 5183, host: '0.0.0.0',
    // Permit only this worktree and its resolved dependencies when node_modules
    // is an isolated-worktree junction. Font binaries must remain readable.
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url)), realpathSync(new URL('./node_modules', import.meta.url))] }, proxy: {
    '/api': { target: 'http://127.0.0.1:3013' },
    '/ws': { target: 'ws://127.0.0.1:3013' },
    '/health': { target: 'http://127.0.0.1:3013' },
  } },
}));
