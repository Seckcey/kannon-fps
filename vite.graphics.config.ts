import { defineConfig, mergeConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import base from './vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: 'node_modules/.vite-kannon-graphics',
  server: { port: 5184, host: '127.0.0.1',
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url)), realpathSync(new URL('./node_modules', import.meta.url))] },
    proxy: { '/api': { target: 'http://127.0.0.1:3014' }, '/ws': { target: 'ws://127.0.0.1:3014' }, '/health': { target: 'http://127.0.0.1:3014' } },
  },
}));
