import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket from 'ws';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:3001');
let healthy = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(2_000) });
    if (response.ok) { healthy = true; break; }
  } catch { /* Container may still be starting. */ }
  await pause(1_000);
}
assert.ok(healthy, 'Deployment must become healthy within 30 seconds.');

const home = await fetch(base, { signal: AbortSignal.timeout(5_000) });
assert.equal(home.status, 200, 'Deployment must serve the production client.');
assert.match(home.headers.get('content-type') ?? '', /text\/html/);
const html = await home.text();
const bundlePath = html.match(/\bsrc="(\/assets\/[^"\s]+\.js)"/u)?.[1];
assert.ok(bundlePath, 'Production HTML must reference a built JavaScript entry point.');
const bundle = await fetch(new URL(bundlePath, base), { signal: AbortSignal.timeout(5_000) });
assert.equal(bundle.status, 200, 'Production JavaScript bundle must be available.');
assert.match(bundle.headers.get('content-type') ?? '', /javascript/);

const wsUrl = new URL('/ws', base);
wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
await new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl, { origin: base.origin });
  const timeout = setTimeout(() => finish(new Error('WebSocket authorization smoke check timed out.')), 5_000);
  const finish = (error) => {
    clearTimeout(timeout);
    socket.terminate();
    error ? reject(error) : resolve();
  };
  socket.once('error', finish);
  socket.once('open', () => socket.send(JSON.stringify({ type: 'create', ranked: false })));
  socket.once('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      assert.equal(message.type, 'error', 'Anonymous clients must not create private rooms.');
      finish();
    } catch (error) { finish(error); }
  });
});
console.log('Production smoke passed: health, built client bundle, WebSocket transport, anonymous room rejection.');
