import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGameServer } from '../../server/app.js';
import { Peer, startReady } from '../acceptance/helpers.js';
import { RULES, type PracticeDifficulty } from '../../shared/protocol.js';

test('practice settings survive recovery and rematch without creating bot profiles or any ranked result', async t => {
  const originalNow = Date.now; let offset = 0; Date.now = () => originalNow() + offset;
  const app = createGameServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:' });
  const { port } = await app.listen(), base = `http://127.0.0.1:${port}`; const peers: Peer[] = [];
  t.after(async () => { try { for (const peer of peers) peer.close(); await app.close(); } finally { Date.now = originalNow; } });
  const hostIdentity = app.store.saveProfile('Practice player'), otherIdentity = app.store.saveProfile('Friend');
  const crew = app.store.createCrew(hostIdentity.profile.id, 'Practice privacy');
  const connect = async (token: string) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: base }), peer = new Peer(socket); peers.push(peer);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await peer.command({ type: 'hello', token, readyProtocol: 1, worldVersion: 'kannon-town-v1' }, 'welcome'); return peer;
  };
  const host = await connect(hostIdentity.token), friend = await connect(otherIdentity.token);
  const defaults = await host.command({ type: 'create', ranked: true, practice: true, crewId: crew.id }, 'room', m => m.room.players.length === 4);
  assert.equal(defaults.room.practiceDifficulty, 'normal'); assert.equal(defaults.room.ranked, false); assert.equal(defaults.room.crewId, undefined);
  assert.equal(defaults.room.players.filter(p => p.bot).length, 3); assert.ok(defaults.room.players.filter(p => p.bot).every(p => /\(AI\)/.test(p.name)));
  await friend.command({ type: 'join', code: defaults.room.code }, 'error');
  for (const difficulty of ['easy', 'normal', 'hard'] as PracticeDifficulty[]) {
    const room = await host.command({ type: 'create', ranked: false, practice: true, practiceDifficulty: difficulty }, 'room', m => m.room.players.length === 4);
    assert.equal(room.room.practiceDifficulty, difficulty);
  }
  const lastRoom = host.messages.filter(m => m.type === 'room').at(-1)!; assert.equal(lastRoom.type, 'room'); if (lastRoom.type !== 'room') return;
  for (const invalid of ['impossible', 1, null, {}, ['hard']]) {
    const mark = host.mark(); host.socket.send(JSON.stringify({ type: 'create', practice: true, ranked: false, practiceDifficulty: invalid }));
    await host.wait('error', m => /difficulty/.test(m.message), mark);
    const preserved = await host.command({ type: 'join', code: lastRoom.room.code }, 'room'); assert.equal(preserved.room.id, lastRoom.room.id);
  }
  await startReady(host, [host]);
  offset += RULES.countdownMs + 20;
  const playing = await host.wait('snapshot', m => m.snapshot.phase === 'playing');
  const moving = await host.wait('snapshot', m => m.snapshot.players.some(p => p.bot && Math.hypot(p.vx, p.vz) > 1));
  assert.equal(moving.snapshot.players.length, 4); assert.equal(playing.snapshot.phase, 'playing');
  const dropped = new Promise<void>(resolve => host.socket.once('close', () => resolve())); host.close(); await dropped;
  const recovered = await connect(hostIdentity.token);
  const recoveredRoom = await recovered.wait('room', m => m.room.id === lastRoom.room.id); assert.equal(recoveredRoom.room.practiceDifficulty, 'hard');
  const mark = recovered.mark(); offset += RULES.matchSeconds * 1000 + 20;
  const end = await recovered.wait('event', m => m.event.type === 'match-end', mark);
  assert.equal(end.event.type, 'match-end'); if (end.event.type !== 'match-end') return;
  assert.equal(end.event.ranked, false); assert.ok(end.event.winnerIds.some(id => id.startsWith('bot-')), 'A time-limit tie includes AI competitors.');
  const rematch = await startReady(recovered, [recovered], 'rematch'); assert.equal(rematch.room.practiceDifficulty, 'hard');
  const reset = await recovered.wait('snapshot', m => m.snapshot.phase === 'countdown');
  assert.ok(reset.snapshot.players.every(p => p.kills === 0 && p.deaths === 0 && p.health === RULES.health && p.shield === RULES.shield));
  const count = (table: string) => app.store.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total;
  assert.equal(count('profiles'), 2, 'Bots must never become persistent identities.');
  for (const table of ['stats', 'matches', 'match_pairs']) assert.equal(count(table), 0, `${table} must not receive practice results.`);
  assert.equal(app.store.leaderboard(hostIdentity.profile.id, crew.id, 'all').history.length, 0);
  const friendsRoom = await recovered.command({ type: 'create', ranked: false, practiceDifficulty: 'hard' }, 'room');
  assert.equal(friendsRoom.room.practice, false); assert.equal(friendsRoom.room.practiceDifficulty, undefined); assert.equal(friendsRoom.room.players.length, 1); assert.equal(friendsRoom.room.players[0]!.bot, undefined);
});
