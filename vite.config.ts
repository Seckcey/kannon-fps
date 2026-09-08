import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the browser-facing Host through the local proxy so the game server can
// enforce the same origin check in development and production (including LAN).
const proxy = (target: string, ws = false): ProxyOptions => ({
  target, ws, changeOrigin: false,
  configure(server) {
    server.on('proxyReq', (request, incoming) => { if (incoming.headers.host) request.setHeader('host', incoming.headers.host); });
    server.on('proxyReqWs', (request, incoming) => { if (incoming.headers.host) request.setHeader('host', incoming.headers.host); });
  },
});

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': proxy('http://127.0.0.1:3001'),
      '/ws': proxy('ws://127.0.0.1:3001', true),
      '/health': proxy('http://127.0.0.1:3001'),
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
});
