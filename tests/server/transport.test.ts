import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../../server/app.js';
import { fixture, frame, Peer, startReady, type Identity } from '../acceptance/helpers.js';
import { RULES, WORLD_VERSION, type Crew } from '../../shared/protocol.js';
import { idleInput } from '../../server/engine.js';
import { LOADOUT_PRESETS } from '../../shared/weapons.js';

test('static serving confines requests to the client directory and gives missing assets real 404 responses', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kannon-static-')); const client = join(directory, 'dist'); mkdirSync(client);
  writeFileSync(join(client, 'index.html'), '<html>GAME SHELL</html>'); writeFileSync(join(directory, 'private.txt'), 'PRIVATE FILE');
  writeFileSync(join(client, '.env'), 'PRIVATE CONFIG'); mkdirSync(join(client, 'assets')); writeFileSync(join(client, 'assets', 'valid.js'), 'console.log("game")');
  mkdirSync(join(client, 'basis')); writeFileSync(join(client, 'basis', 'ktx2-worker.js'), 'self.onmessage = () => {}'); writeFileSync(join(client, 'basis', 'basis_transcoder.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  const app = createGameServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', staticDir: client }); const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\kannon-static-') || resolve(directory).startsWith(resolve(tmpdir()) + '/kannon-static-')); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(base + '/')).status, 200); assert.equal((await fetch(base + '/friends')).status, 200);
  for (const path of ['/missing.js', '/assets/missing', '/assets/missing.js', '/.env', '/%2e%2e/private.txt', '/..%5cprivate.txt', '/%252e%252e/private.txt']) {
    const result = await fetch(base + path); assert.ok([400, 403, 404].includes(result.status), `${path}: ${result.status}`);
    assert.ok(!(await result.text()).includes('PRIVATE'), `Never disclose private content via ${path}`);
  }
  const asset = await fetch(base + '/assets/valid.js'); assert.equal(asset.status, 200); assert.match(asset.headers.get('cache-control')!, /immutable/);
  const scriptPolicy = asset.headers.get('content-security-policy')!.split(';').find(d => d.trim().startsWith('script-src'))!.trim();
  assert.equal(scriptPolicy, "script-src 'self' 'wasm-unsafe-eval'", 'Bundled art decoder works without allowing JavaScript eval or external scripts');
  // Only the texture transcoder worker may construct functions from source, and only when served from this origin.
  const worker = await fetch(base + '/basis/ktx2-worker.js'); assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('content-security-policy'), "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'");
  assert.match(worker.headers.get('content-type')!, /javascript/);
  const wasm = await fetch(base + '/basis/basis_transcoder.wasm'); assert.equal(wasm.status, 200); assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal(wasm.headers.get('content-security-policy')!.split(';').find(d => d.trim().startsWith('script-src'))!.trim(), "script-src 'self' 'wasm-unsafe-eval'", 'Every other file keeps the page policy');
  const oversized = await fetch(base + '/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(9000) }) }); assert.equal(oversized.status, 413);
});

test('abrupt host drop transfers control and authenticated recovery cannot duplicate player identity', async t => {
  const f = await fixture(t); const owner = await f.profile('Original host'); const friend = await f.profile('Next host');
  const host = await f.connect(owner.token); const guest = await f.connect(friend.token);
  const created = await host.command({ type: 'create', ranked: false }, 'room'); assert.match(created.room.code, /^[0-9A-F]{20}$/);
  await guest.command({ type: 'join', code: created.room.code }, 'room', m => m.room.players.length === 2);
  const mark = guest.mark(); host.close();
  await guest.wait('room', m => m.room.hostId === friend.profile.id && m.room.players.some(p => p.id === owner.profile.id && !p.connected), mark);
  const recovered = await f.connect(owner.token); const room = await recovered.wait('room', m => m.room.id === created.room.id);
  assert.equal(room.room.hostId, friend.profile.id); assert.equal(room.room.players.filter(p => p.id === owner.profile.id).length, 1);
  await recovered.command({ type: 'start' }, 'error');
  await startReady(guest, [guest, recovered]);
  // A failed start cannot prune a disconnected player or reset match eligibility.
  const dropMark = guest.mark(); recovered.close();
  await guest.wait('room', m => m.room.players.some(p => p.id === owner.profile.id && !p.connected), dropMark);
  await guest.command({ type: 'start' }, 'error');
  const resumed = await f.connect(owner.token); const resumedRoom = await resumed.wait('room', m => m.room.id === created.room.id);
  assert.equal(resumedRoom.room.players.length, 2); assert.equal(resumedRoom.room.phase, 'countdown');
  const endMark = guest.mark(); resumed.send({ type: 'leave' });
  const ended = await guest.wait('event', m => m.event.type === 'match-end', endMark);
  assert.equal(ended.event.type, 'match-end'); if (ended.event.type === 'match-end') { assert.equal(ended.event.ranked, false); assert.deepEqual(ended.event.winnerIds, []); }
});
test('joining an expired or unknown room reports a machine-readable error and preserves a valid current room', async t => {
  const f = await fixture(t); const owner = await f.profile('Room recovery'); const host = await f.connect(owner.token);
  const created = await host.command({ type: 'create', ranked: false }, 'room');
  const missing = await host.command({ type: 'join', code: '00000000000000000000' }, 'error'); assert.equal(missing.code, 'ROOM_NOT_FOUND');
  const same = await host.command({ type: 'join', code: created.room.code }, 'room'); assert.equal(same.room.id, created.room.id);
});
test('first returning player becomes host after an entire lobby disconnects', async t => {
  const f = await fixture(t); const a = await f.profile('Returning host'); const b = await f.profile('Offline friend'); const c = await f.profile('New friend');
  const host = await f.connect(a.token), guest = await f.connect(b.token);
  const created = await host.command({ type: 'create', ranked: false }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room', m => m.room.players.length === 2);
  const mark = guest.mark(); host.close(); await guest.wait('room', m => m.room.hostId === b.profile.id && m.room.players.some(p => p.id === a.profile.id && !p.connected), mark);
  guest.close();
  const returned = await f.connect(a.token);
  await returned.wait('room', m => m.room.id === created.room.id && m.room.hostId === a.profile.id);
  const newcomer = await f.connect(c.token); await newcomer.command({ type: 'join', code: created.room.code }, 'room', m => m.room.players.filter(p => p.connected).length === 2);
  const started = await startReady(returned, [returned, newcomer]);
  assert.equal(started.room.hostId, a.profile.id); assert.deepEqual(new Set(started.room.players.map(p => p.id)), new Set([a.profile.id, c.profile.id]));
});
test('automatic reconnect followed by same-room join is idempotent and accepts a fresh input sequence', async t => {
  const f = await fixture(t); const a = await f.profile('Phone player'), b = await f.profile('Desktop player');
  const host = await f.connect(a.token), guest = await f.connect(b.token);
  const created = await host.command({ type: 'create', ranked: false }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room', m => m.room.players.length === 2);
  await startReady(host, [host, guest]);
  await host.wait('snapshot', m => m.snapshot.phase === 'playing');
  const inputMark = host.mark(); host.send({ type: 'input', input: { ...idleInput(100), slot: 2 } });
  await host.wait('snapshot', m => m.snapshot.players.some(p => p.id === a.profile.id && p.lastInputSeq === 100), inputMark);
  const dropMark = guest.mark(); host.close(); await guest.wait('room', m => m.room.players.some(p => p.id === a.profile.id && !p.connected), dropMark);
  const returned = await f.connect(a.token); await returned.wait('room', m => m.room.id === created.room.id && m.room.phase === 'playing');
  const joined = await returned.command({ type: 'join', code: created.room.code }, 'room'); assert.equal(joined.room.phase, 'playing'); assert.equal(joined.room.players.length, 2);
  const seqMark = returned.mark(); returned.send({ type: 'input', input: { ...idleInput(1), slot: 1 } });
  const fresh = await returned.wait('snapshot', m => m.snapshot.players.some(p => p.id === a.profile.id && p.lastInputSeq === 1 && p.slot === 1), seqMark);
  assert.equal(fresh.snapshot.phase, 'playing'); assert.equal(returned.messages.some(m => m.type === 'event' && m.event.type === 'match-end'), false);
  assert.equal(fresh.snapshot.self?.id, a.profile.id, 'A recovered socket gets its own full state again.');
});
test('loadouts are checked, follow the player into a room, and wait for the next spawn once play has begun', async t => {
  const f = await fixture(t); const a = await f.profile('Class picker'), b = await f.profile('Rival');
  const host = await f.connect(a.token), guest = await f.connect(b.token);
  host.send({ type: 'loadout', loadout: LOADOUT_PRESETS.close });
  const created = await host.command({ type: 'create', ranked: false }, 'room');
  const lobby = await host.wait('snapshot', m => !!m.snapshot.self);
  assert.deepEqual(lobby.snapshot.self!.loadout, LOADOUT_PRESETS.close, 'A class chosen before joining applies in the lobby.');
  assert.equal(lobby.snapshot.self!.weapon, 'hornet9'); assert.deepEqual(lobby.snapshot.self!.mag, [32, 12]);
  for (const loadout of [{ ...LOADOUT_PRESETS.close, perks: ['quick-hands', 'deep-pockets', 'second-wind'] }, { ...LOADOUT_PRESETS.close, primary: 'rocket' }, null, 'assault']) {
    const error = await host.command({ type: 'loadout', loadout: loadout as never }, 'error');
    assert.equal(error.code, 'INVALID_LOADOUT');
  }
  await guest.command({ type: 'join', code: created.room.code }, 'room', m => m.room.players.length === 2);
  await startReady(host, [host, guest]);
  await host.wait('snapshot', m => m.snapshot.phase === 'playing');
  const mark = host.mark(); host.send({ type: 'loadout', loadout: LOADOUT_PRESETS.marksman });
  await host.command({ type: 'ping', t: 7 }, 'pong');
  const later = await host.wait('snapshot', m => m.snapshot.phase === 'playing', mark);
  assert.deepEqual(later.snapshot.self!.loadout, LOADOUT_PRESETS.close, 'A new class waits for the next spawn.');
  assert.equal(host.messages.slice(mark).some(m => m.type === 'error'), false);
});
test('malformed or hostile inputs are refused without stopping the room, and unearned rewards do nothing', async t => {
  const f = await fixture(t); const a = await f.profile('Hostile page'), b = await f.profile('Honest page');
  const host = await f.connect(a.token), guest = await f.connect(b.token);
  const created = await host.command({ type: 'create', ranked: false }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room', m => m.room.players.length === 2);
  await startReady(host, [host, guest]);
  await host.wait('snapshot', m => m.snapshot.phase === 'playing');
  const hostile = [
    { ...frame(1), viewTime: null }, { ...frame(1), viewTime: 'now' }, frame(1, { streak: 'mortar', streakTarget: { x: 999, z: 0 } }), { ...frame(1), streak: 'nuke' },
    { ...frame(1), slot: 3 }, { ...frame(1), crouch: 'yes' }, { seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: true, aim: false, jump: false, sprint: false, reload: false, slot: 1 },
  ];
  for (const input of hostile) {
    const error = await host.command({ type: 'input', input: input as never }, 'error');
    assert.match(error.message, /invalid player input/i);
  }
  const mark = host.mark(); host.send({ type: 'input', input: frame(1, { streak: 'drone', moveX: 1 }) });
  const accepted = await host.wait('snapshot', m => m.snapshot.players.some(p => p.id === a.profile.id && p.lastInputSeq === 1), mark);
  assert.equal(accepted.snapshot.phase, 'playing'); assert.deepEqual(accepted.snapshot.drones, []);
  assert.equal(host.messages.slice(mark).some(m => m.type === 'event' && m.event.type === 'streak'), false, 'An unearned reward does nothing.');
  await guest.wait('snapshot', m => m.snapshot.serverTime > accepted.snapshot.serverTime, guest.mark());
});
test('message compression stays off by default and, when switched on, still delivers rooms and snapshots', async t => {
  const plain = await fixture(t);
  assert.equal((await plain.connect()).socket.extensions, '', 'Without the switch the server never compresses.');
  const app = createGameServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', staticDir: join(tmpdir(), 'kannon-no-client'), compression: true });
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  let peer: Peer | undefined;
  t.after(async () => { peer?.close(); await app.close(); });
  const response = await fetch(base + '/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Phone on mobile data' }) });
  const identity = await response.json() as Identity;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: base }); peer = new Peer(socket);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  assert.match(socket.extensions, /permessage-deflate/);
  await peer.command({ type: 'hello', token: identity.token, readyProtocol: 1, worldVersion: WORLD_VERSION }, 'welcome');
  const created = await peer.command({ type: 'create', ranked: false, practice: true }, 'room', m => m.room.players.length === 4);
  const lobby = await peer.wait('snapshot', m => m.snapshot.players.length === 4);
  assert.equal(lobby.snapshot.self?.id, identity.profile.id); assert.equal(created.room.practice, true);
  assert.ok(JSON.stringify(lobby).length > 1024, 'Setup: the snapshot is large enough to be compressed.');
});
test('finished recovery replays the saved ranked result exactly once without another rating write and clears it on rematch', async t => {
  const originalNow = Date.now; let offset = 0; Date.now = () => originalNow() + offset;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t); const a = await f.profile('Finished host'), b = await f.profile('Finished friend');
  const crewResponse = await f.request('/api/crews', { token: a.token, body: { name: 'Recovery results' } });
  const { crew } = await crewResponse.json() as { crew: Crew };
  await f.request('/api/crews/join', { token: b.token, body: { invite: crew.invite } });
  const host = await f.connect(a.token), guest = await f.connect(b.token);
  const created = await host.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room', m => m.room.players.length === 2);
  await startReady(host, [host, guest]);
  offset += RULES.countdownMs + 50; await host.wait('snapshot', m => m.snapshot.phase === 'playing');
  const endMark = host.mark(); offset += RULES.matchSeconds * 1000 + 50;
  const ended = await host.wait('event', m => m.event.type === 'match-end', endMark);
  assert.equal(ended.event.type, 'match-end'); if (ended.event.type !== 'match-end') return;
  assert.equal(ended.event.ranked, true); assert.match(ended.event.reason, /saved/i);
  const board = async () => (await (await f.request(`/api/leaderboard?crewId=${crew.id}&period=all`, { token: a.token })).json());
  assert.equal((await board()).history.length, 1);
  const dropMark = guest.mark(); host.close(); await guest.wait('room', m => m.room.players.some(p => p.id === a.profile.id && !p.connected), dropMark);
  const recovered = await f.connect(a.token); const replay = await recovered.wait('event', m => m.event.type === 'match-end');
  assert.deepEqual(replay.event, ended.event);
  await recovered.command({ type: 'join', code: created.room.code }, 'room');
  assert.equal(recovered.messages.filter(m => m.type === 'event' && m.event.type === 'match-end').length, 1);
  const stored = await board(); assert.equal(stored.history.length, 1); assert.ok(stored.entries.every((entry: { matches: number }) => entry.matches === 1));
  await startReady(guest, [guest, recovered], 'rematch');
  const secondDrop = guest.mark(); recovered.close(); await guest.wait('room', m => m.room.players.some(p => p.id === a.profile.id && !p.connected), secondDrop);
  const midRematch = await f.connect(a.token); await midRematch.wait('snapshot', m => m.snapshot.phase === 'countdown');
  assert.equal(midRematch.messages.some(m => m.type === 'event' && m.event.type === 'match-end'), false);
  assert.equal((await board()).history.length, 1);
});
