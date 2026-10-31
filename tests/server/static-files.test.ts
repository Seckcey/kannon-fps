import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGameServer } from '../../server/app.js';

async function serve(t: TestContext, files: Record<string, string | Buffer>) {
  const directory = mkdtempSync(join(tmpdir(), 'kannon-static-')), client = join(directory, 'dist');
  for (const [path, content] of Object.entries({ 'index.html': '<html>GAME SHELL</html>', ...files })) {
    mkdirSync(join(client, path, '..'), { recursive: true }); writeFileSync(join(client, path), content);
  }
  const app = createGameServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', staticDir: client });
  const { port } = await app.listen();
  t.after(async () => {
    await app.close();
    assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), 'kannon-static-')));
    rmSync(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, port, client };
}

test('static files carry validators and a length, and an unchanged copy is confirmed with an empty 304', async t => {
  const model = Buffer.alloc(200_000, 7);
  const { base, client } = await serve(t, { 'models/operator-v1.glb': model, 'assets/index-abc123.js': 'console.log("game")' });
  const url = `${base}/models/operator-v1.glb?v=operator-v1`;
  const first = await fetch(url);
  assert.equal(first.status, 200); assert.equal((await first.arrayBuffer()).byteLength, model.length);
  const etag = first.headers.get('etag')!, modified = first.headers.get('last-modified')!;
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/); assert.ok(Number.isFinite(Date.parse(modified)));
  assert.equal(first.headers.get('content-length'), String(model.length));
  assert.equal(first.headers.get('cache-control'), 'no-cache', 'Hand-versioned URLs stay revalidated.');
  const fresh: Array<Record<string, string>> = [{ 'if-none-match': etag }, { 'if-none-match': `"other", ${etag}` }, { 'if-modified-since': modified }, { 'if-none-match': '*' }];
  for (const headers of fresh) {
    const again = await fetch(url, { headers });
    assert.equal(again.status, 304, JSON.stringify(headers)); assert.equal((await again.arrayBuffer()).byteLength, 0);
    assert.equal(again.headers.get('etag'), etag);
  }
  const older = new Date(Date.parse(modified) - 60_000).toUTCString();
  const stale: Array<Record<string, string>> = [{ 'if-none-match': 'W/"stale-copy"' }, { 'if-modified-since': older }, { 'if-none-match': 'W/"stale-copy"', 'if-modified-since': modified }];
  for (const headers of stale) {
    assert.equal((await fetch(url, { headers })).status, 200, `A changed copy is sent again: ${JSON.stringify(headers)}`);
  }
  // Re-exporting the file changes its validators, so a browser holding the old copy downloads the new one.
  writeFileSync(join(client, 'models', 'operator-v1.glb'), Buffer.alloc(200_001, 8)); utimesSync(join(client, 'models', 'operator-v1.glb'), new Date(), new Date(Date.now() + 5_000));
  const updated = await fetch(url, { headers: { 'if-none-match': etag } });
  assert.equal(updated.status, 200); assert.notEqual(updated.headers.get('etag'), etag); assert.equal((await updated.arrayBuffer()).byteLength, 200_001);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(statSync(join(client, 'models', 'operator-v1.glb')).size));
  // The page shell and hashed bundles get validators too; client routes share the shell's.
  const shell = await fetch(`${base}/`), route = await fetch(`${base}/friends`);
  assert.ok(shell.headers.get('etag')); assert.equal(route.headers.get('etag'), shell.headers.get('etag'));
  assert.equal((await fetch(`${base}/`, { headers: { 'if-none-match': shell.headers.get('etag')! } })).status, 304);
  const bundle = await fetch(`${base}/assets/index-abc123.js`);
  assert.match(bundle.headers.get('cache-control')!, /immutable/); assert.ok(bundle.headers.get('etag'));
});

test('an abandoned download closes its file at once', async t => {
  const streams: fs.ReadStream[] = [], original = fs.createReadStream;
  // Watch the read streams the server opens (the server imports createReadStream from node:fs).
  (fs as { createReadStream: typeof fs.createReadStream }).createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    const stream = original(...args); streams.push(stream); return stream;
  }) as typeof fs.createReadStream;
  syncBuiltinESMExports();
  t.after(() => { (fs as { createReadStream: typeof fs.createReadStream }).createReadStream = original; syncBuiltinESMExports(); });
  const { port } = await serve(t, { 'models/environment-v3.glb': Buffer.alloc(24 * 1024 * 1024) });
  // A phone that loses its signal, or the page's own download timeout: one chunk, then the connection is gone.
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((done, fail) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET /models/environment-v3.glb?v=kannon-town-v3 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
      socket.once('data', () => { socket.destroy(); done(); }); socket.once('error', fail);
    });
  }
  assert.equal(streams.length, 3, 'Setup: the server read the model through node:fs streams.');
  await Promise.all(streams.map(stream => stream.closed ? undefined : new Promise<void>(done => { const timer = setTimeout(done, 3_000); stream.once('close', () => { clearTimeout(timer); done(); }); })));
  assert.deepEqual(streams.map(stream => stream.closed), [true, true, true], 'Every abandoned download released its file.');
});
