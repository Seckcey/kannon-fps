import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA_ASSETS, getArenaAssetBuffer, warmArenaAssets } from '../../src/game/assets.js';

function glb(): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{}] }));
  const length = Math.ceil(json.length / 4) * 4, buffer = new ArrayBuffer(20 + length), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).fill(0x20); new Uint8Array(buffer, 20, json.length).set(json); return buffer;
}

test('model warmup shares retained buffers, rejects corrupt responses, and retries aborts without refetching good assets', async t => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let respond: (init?: RequestInit) => Promise<Response> = async () => new Response(glb());
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init }); return respond(init);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(getArenaAssetBuffer('/not-an-arena-asset.glb'), /Unknown/); assert.equal(requests.length, 0);

  const malformed = [
    new ArrayBuffer(12),
    (() => { const b = glb(); new DataView(b).setUint32(4, 1, true); return b; })(),
    (() => { const b = glb(); new DataView(b).setUint32(8, b.byteLength + 4, true); return b; })(),
    (() => { const b = glb(); new DataView(b).setUint32(12, b.byteLength, true); return b; })(),
    (() => { const b = glb(); new DataView(b).setUint32(16, 0x004e4942, true); return b; })(),
    (() => { const b = glb(); new Uint8Array(b)[20] = 0; return b; })(),
  ];
  for (const buffer of malformed) {
    respond = async () => new Response(buffer);
    await assert.rejects(getArenaAssetBuffer(ARENA_ASSETS.environment), /incomplete or unavailable/);
  }
  assert.equal(requests[0]!.init?.cache, 'force-cache');
  assert.ok(requests.slice(1).every(request => request.init?.cache === 'reload'), 'A corrupt HTTP-cache entry must not poison retries.');
  const notFound = new Response('Missing artwork', { status: 404 }); respond = async () => notFound;
  await assert.rejects(getArenaAssetBuffer(ARENA_ASSETS.environment), /could not load/); assert.equal(notFound.bodyUsed, true, 'Failed HTTP response bodies must be canceled.');
  respond = async () => { throw new TypeError('Network unavailable'); };
  await assert.rejects(getArenaAssetBuffer(ARENA_ASSETS.environment), /Check your connection/);

  await t.test('a stalled download owns one deadline and remains retryable afterward', async timeout => {
    timeout.mock.timers.enable({ apis: ['setTimeout'] });
    let signal: AbortSignal | null | undefined;
    respond = init => new Promise((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const pending = getArenaAssetBuffer(ARENA_ASSETS.environment), rejected = assert.rejects(pending, /took too long/);
    assert.equal(getArenaAssetBuffer(ARENA_ASSETS.environment), pending, 'Concurrent readers share the same request and deadline.');
    timeout.mock.timers.tick(59_999); assert.equal(signal?.aborted, false);
    timeout.mock.timers.tick(1); await rejected; assert.equal(signal?.aborted, true);
  });

  const valid = glb(); respond = async () => new Response(valid);
  const environment = getArenaAssetBuffer(ARENA_ASSETS.environment), environmentBuffer = await environment;
  assert.equal(requests.at(-1)!.init?.cache, 'reload'); assert.equal(environmentBuffer.byteLength, valid.byteLength);
  assert.equal(getArenaAssetBuffer(ARENA_ASSETS.environment), environment);

  await t.test('warmup and multiple parsers share one download and successful buffers outlive the request deadline', async cached => {
    cached.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveResponse!: (response: Response) => void;
    respond = () => new Promise(resolve => { resolveResponse = resolve; });
    const before = requests.length;
    const character = getArenaAssetBuffer(ARENA_ASSETS.character), warm = warmArenaAssets();
    const parsers = Array.from({ length: 8 }, () => getArenaAssetBuffer(ARENA_ASSETS.character));
    assert.ok(parsers.every(parser => parser === character)); assert.equal(requests.length, before + 1);
    resolveResponse(new Response(valid));
    const characterBuffer = await character; await warm;
    assert.ok((await Promise.all(parsers)).every(buffer => buffer === characterBuffer));
    assert.equal(await getArenaAssetBuffer(ARENA_ASSETS.environment), environmentBuffer, 'Retrying one asset must preserve the other buffer.');
    cached.mock.timers.tick(60_001); assert.equal(requests.at(-1)!.init?.signal?.aborted, false, 'A completed request must clear its abort deadline.');
    await warmArenaAssets(); assert.equal(requests.length, before + 1, 'A later room must not depend on another model request.');
    assert.deepEqual(new Uint8Array(characterBuffer), new Uint8Array(valid));
  });
});
