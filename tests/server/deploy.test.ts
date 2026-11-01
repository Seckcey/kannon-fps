import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createGameServer } from '../../server/app.js';
import { Peer } from '../acceptance/helpers.js';
import { WORLD_VERSION, type AvailableGame } from '../../shared/protocol.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('the production smoke check passes while public lobbies of both modes are open', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kannon-smoke-')), client = join(directory, 'dist');
  mkdirSync(join(client, 'assets'), { recursive: true });
  writeFileSync(join(client, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-smoke.js"></script></head></html>');
  writeFileSync(join(client, 'assets', 'index-smoke.js'), 'console.log("game")');
  const app = createGameServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', staticDir: client });
  const base = `http://127.0.0.1:${(await app.listen()).port}`, peers: Peer[] = [];
  t.after(async () => {
    for (const peer of peers) peer.close();
    await app.close();
    assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), 'kannon-smoke-'))); rmSync(directory, { recursive: true, force: true });
  });
  for (const [name, mode] of [['Smoke host', 'ffa'], ['Team host', 'tdm']] as const) {
    const identity = app.store.saveProfile(name), socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, { origin: base }), peer = new Peer(socket); peers.push(peer);
    await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail); });
    await peer.command({ type: 'hello', token: identity.token, readyProtocol: 1, worldVersion: WORLD_VERSION }, 'welcome');
    await peer.command({ type: 'create', ranked: false, visibility: 'public', mode, ...(mode === 'tdm' ? { fillBots: true, botDifficulty: 'hard' } : {}) }, 'room');
  }
  const { games } = await (await fetch(`${base}/api/games`)).json() as { games: AvailableGame[] };
  assert.deepEqual(games.map(game => game.mode).sort(), ['ffa', 'tdm'], 'Setup: two public lobbies are listed.');
  const result = await new Promise<{ code: number | null; output: string }>(done => {
    execFile(process.execPath, [join(root, 'deploy', 'smoke.mjs'), base], { cwd: root, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Production smoke passed/);
});

test('the container passes the compression switch and the trusted visitor header through, and Coastline trusts Cloudflare\'s', () => {
  const compose = read('deploy/compose.yml'), coastline = read('deploy/coastline.compose.yml');
  const environment = (text: string) => /^\s{4}environment:\n((?:\s{6}.*\n)+)/m.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
  assert.match(environment(compose), /^\s+WS_COMPRESSION: "\$\{WS_COMPRESSION:-\}"$/m, 'WS_COMPRESSION=1 in the .env file reaches the server.');
  assert.match(environment(compose), /^\s+TRUSTED_CLIENT_IP_HEADER: "\$\{TRUSTED_CLIENT_IP_HEADER:-\}"$/m);
  assert.match(environment(coastline), /^\s+TRUSTED_CLIENT_IP_HEADER: cf-connecting-ip$/m, 'Behind the tunnel every player has their own rate limit.');
  assert.match(compose, /"\$\{BIND_ADDRESS:-127\.0\.0\.1\}:/, 'The published port stays on loopback unless an operator opens it on purpose.');
});

test('the production image leaves out superseded art but never anything the game page loads', () => {
  const ignored = read('.dockerignore').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const art = ignored.filter(line => line.startsWith('public/'));
  for (const path of art) assert.ok(existsSync(join(root, path)) && statSync(join(root, path)).isFile(), `${path} names a real file`);
  const legacy = ['environment.glb', 'environment-refined.glb', 'environment-v2.glb', 'environment-v2-phone.glb', 'environment-vehicle-test.glb', 'scout.glb', 'scout-v2.glb', 'vehicles-current.glb', 'vehicles-improved.glb'].map(name => `public/models/${name}`);
  for (const path of [...legacy, 'public/assets/limestone.png', 'public/assets/sunbreak-lobby.png']) assert.ok(art.includes(path), `${path} stays out of the image`);
  // What the production page asks for: the arena models and every image named in the page or its source.
  const arena = /ARENA_ASSETS = \{([\s\S]*?)\}/.exec(read('src/game/assets.ts'))?.[1] ?? '';
  const models = [...arena.matchAll(/'\/(models\/[^'?]+)/g)].map(match => `public/${match[1]}`);
  assert.ok(models.length >= 4, 'Setup: the arena models were found.');
  const sources: string[] = ['index.html'];
  const walk = (dir: string) => { for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) { const path = `${dir}/${entry.name}`; if (entry.isDirectory()) { if (path !== 'src/vehicle-test') walk(path); } else if (/\.(tsx?|css|html)$/.test(entry.name)) sources.push(path); } };
  walk('src');
  const images = new Set(sources.flatMap(path => [...read(path).matchAll(/\/assets\/([\w.-]+\.(?:png|jpg|webp|svg))/g)].map(match => `public/assets/${match[1]}`)));
  assert.ok(images.size >= 1, 'Setup: the page images were found.');
  for (const path of [...models, ...images]) assert.ok(!art.includes(path), `${path} is loaded by the game and must ship`);
});
