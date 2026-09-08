import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGameServer } from '../../server/app.js';
import { fixture } from '../acceptance/helpers.js';

test('static serving confines requests to the client directory and gives missing assets real 404 responses', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kannon-static-')); const client = join(directory, 'dist'); mkdirSync(client);
  writeFileSync(join(client, 'index.html'), '<html>GAME SHELL</html>'); writeFileSync(join(directory, 'private.txt'), 'PRIVATE FILE');
  writeFileSync(join(client, '.env'), 'PRIVATE CONFIG'); mkdirSync(join(client, 'assets')); writeFileSync(join(client, 'assets', 'valid.js'), 'console.log("game")');
  const app = createGameServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', staticDir: client }); const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\kannon-static-') || resolve(directory).startsWith(resolve(tmpdir()) + '/kannon-static-')); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(base + '/')).status, 200); assert.equal((await fetch(base + '/friends')).status, 200);
  for (const path of ['/missing.js', '/assets/missing', '/assets/missing.js', '/.env', '/%2e%2e/private.txt', '/..%5cprivate.txt', '/%252e%252e/private.txt']) {
    const result = await fetch(base + path); assert.ok([400, 403, 404].includes(result.status), `${path}: ${result.status}`);
    assert.ok(!(await result.text()).includes('PRIVATE'), `Never disclose private content via ${path}`);
  }
  const asset = await fetch(base + '/assets/valid.js'); assert.equal(asset.status, 200); assert.match(asset.headers.get('cache-control')!, /immutable/);
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
  await guest.command({ type: 'start' }, 'room', m => m.room.phase === 'countdown');
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
