import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { RULES, type Crew, type InputFrame, type LeaderboardEntry, type MatchHistory } from '../../shared/protocol.js';
import { fixture } from './helpers.js';

const input = (seq: number, changes: Partial<InputFrame> = {}): InputFrame => ({ seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1, ...changes });

test('HTTP identity cannot be impersonated by nickname and survives a server restart', async t => {
  const f = await fixture(t);
  const first = await f.profile('River');
  const sameName = await f.profile('River');
  assert.notEqual(first.profile.id, sameName.profile.id);
  assert.notEqual(first.token, sameName.token);
  assert.equal((await f.request('/api/profile')).status, 401);
  assert.equal((await f.request('/api/profile', { token: 'f'.repeat(64) })).status, 401);
  const saved = await f.request('/api/profile', { body: { name: 'River Prime', token: first.token } });
  assert.ok(saved.ok);
  const renamed = await saved.json();
  assert.equal(renamed.profile.id, first.profile.id);
  assert.equal(renamed.profile.name, 'River Prime');
  assert.equal(renamed.token, first.token);
  assert.ok(!(await f.request('/api/profile', { body: { name: 'River Prime', token: 'f'.repeat(64) } })).ok);
  await f.restart();
  const restored = await f.request('/api/profile', { token: first.token });
  assert.equal(restored.status, 200);
  assert.deepEqual((await restored.json()).profile, renamed.profile);
  const other = await f.request('/api/profile', { token: sameName.token });
  assert.equal((await other.json()).profile.name, 'River');
});

test('private crews and both leaderboard periods require membership and persist', async t => {
  const f = await fixture(t);
  const owner = await f.profile('Crew Owner'); const friend = await f.profile('Crew Friend'); const outsider = await f.profile('Outsider');
  const created = await f.request('/api/crews', { token: owner.token, body: { name: 'Our Rivals' } });
  assert.ok(created.ok);
  const { crew } = await created.json() as { crew: Crew };
  assert.equal(crew.ownerId, owner.profile.id);
  assert.equal(crew.memberCount, 1);
  for (const period of ['all', 'month']) {
    assert.equal((await f.request(`/api/leaderboard?crewId=${crew.id}&period=${period}`)).status, 401);
    const denied = await f.request(`/api/leaderboard?crewId=${crew.id}&period=${period}`, { token: outsider.token });
    assert.ok(!denied.ok, 'A known crew ID must not disclose its leaderboard to a non-member.');
    assert.equal(Object.hasOwn(await denied.json(), 'entries'), false);
  }
  const outsiderCrews = await f.request('/api/crews', { token: outsider.token });
  assert.deepEqual((await outsiderCrews.json()).crews, []);
  const joined = await f.request('/api/crews/join', { token: friend.token, body: { invite: crew.invite } });
  assert.ok(joined.ok);
  assert.equal((await joined.json()).crew.memberCount, 2);
  const joinedAgain = await f.request('/api/crews/join', { token: friend.token, body: { invite: crew.invite } });
  assert.equal((await joinedAgain.json()).crew.memberCount, 2, 'Repeating an invitation must not duplicate membership.');
  await f.restart();
  for (const period of ['all', 'month']) {
    const response = await f.request(`/api/leaderboard?crewId=${crew.id}&period=${period}`, { token: friend.token });
    assert.equal(response.status, 200);
    const board = await response.json() as { entries: LeaderboardEntry[]; history: MatchHistory[] };
    assert.deepEqual(new Set(board.entries.map(entry => entry.id)), new Set([owner.profile.id, friend.profile.id]));
    assert.deepEqual(board.history, []);
    for (const entry of board.entries) {
      assert.equal(entry.matches, 0); assert.equal(entry.wins, 0); assert.equal(entry.placed, false); assert.equal(entry.rank, null);
      assert.equal(Object.hasOwn(entry, 'token'), false);
      assert.equal(Object.hasOwn(entry, 'token_hash'), false);
    }
  }
});

test('WebSocket transport rejects foreign origins, missing identity, and invalid credentials', async t => {
  const f = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(f.base.replace(/^http/, 'ws') + '/ws', { origin: 'https://unrelated.example' });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Foreign-origin upgrade was not rejected.')); }, 3_000);
    socket.once('open', () => { clearTimeout(timeout); socket.terminate(); reject(new Error('Foreign-origin WebSocket was accepted.')); });
    socket.once('error', error => { clearTimeout(timeout); assert.match(error.message, /403/); resolve(); });
  });
  const anonymous = await f.connect();
  await anonymous.command({ type: 'create', ranked: false }, 'error');
  await anonymous.command({ type: 'hello', token: 'f'.repeat(64) }, 'error');
  assert.equal(anonymous.messages.some(message => message.type === 'welcome' || message.type === 'room'), false);
  assert.equal((await f.request('/health')).status, 200);
});

test('private multiplayer enforces crew access, host control, countdown, fixed loadout, and authoritative input', async t => {
  const f = await fixture(t);
  const owner = await f.profile('Captain'); const friend = await f.profile('Contender');
  const crewResponse = await f.request('/api/crews', { token: owner.token, body: { name: 'Family Arena' } });
  const { crew } = await crewResponse.json() as { crew: Crew };
  const host = await f.connect(owner.token); const guest = await f.connect(friend.token);
  const created = await host.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  assert.equal(created.room.hostId, owner.profile.id);
  assert.equal(created.room.phase, 'waiting');
  await host.command({ type: 'start' }, 'error');
  await guest.command({ type: 'join', code: created.room.code }, 'error');
  await f.request('/api/crews/join', { token: friend.token, body: { invite: crew.invite } });
  const joined = await guest.command({ type: 'join', code: created.room.code }, 'room', message => message.room.players.length === 2);
  assert.deepEqual(new Set(joined.room.players.map(player => player.id)), new Set([owner.profile.id, friend.profile.id]));
  await guest.command({ type: 'start' }, 'error');
  const hostMark = host.mark(); const guestMark = guest.mark();
  host.send({ type: 'start' });
  await host.wait('room', message => message.room.phase === 'countdown', hostMark);
  const [hostPlaying, guestPlaying] = await Promise.all([
    host.wait('snapshot', message => message.snapshot.phase === 'playing', hostMark),
    guest.wait('snapshot', message => message.snapshot.phase === 'playing', guestMark),
  ]);
  assert.equal(hostPlaying.snapshot.players.length, 2);
  assert.deepEqual(hostPlaying.snapshot.players, guestPlaying.snapshot.players);
  for (const player of hostPlaying.snapshot.players) {
    assert.equal(player.health, RULES.health); assert.equal(player.shield, RULES.shield); assert.equal(player.heals, 2);
    assert.equal(player.slot, 1); assert.equal(player.ammoAR, RULES.arMagazine); assert.equal(player.ammoShotgun, RULES.shotgunMagazine);
    assert.equal(player.kills, 0); assert.equal(player.deaths, 0);
  }
  const before = hostPlaying.snapshot.players.find(player => player.id === owner.profile.id)!;
  const mark = host.mark();
  // The wire accepts input intent only: injected coordinates and score fields have no authority.
  host.socket.send(JSON.stringify({ type: 'input', input: { ...input(1, { moveX: 999_999, slot: 2 }), x: 1000, health: 999, kills: 15 } }));
  const moved = await host.wait('snapshot', message => message.snapshot.players.some(player => player.id === owner.profile.id && player.lastInputSeq === 1), mark);
  const after = moved.snapshot.players.find(player => player.id === owner.profile.id)!;
  assert.equal(after.slot, 2); assert.equal(after.health, RULES.health); assert.equal(after.kills, 0);
  const elapsed = (moved.snapshot.serverTime - hostPlaying.snapshot.serverTime) / 1000;
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) <= 9 * elapsed + 0.5, 'Movement must be bounded by server speed, even for huge client input.');
  const staleMark = host.mark(); host.send({ type: 'input', input: input(1, { slot: 3 }) });
  const stale = await host.wait('snapshot', message => message.snapshot.tick > moved.snapshot.tick, staleMark);
  assert.equal(stale.snapshot.players.find(player => player.id === owner.profile.id)!.slot, 2, 'Replayed input must not alter the player.');
  const stoppedMark = host.mark();
  const stopped = await host.wait('snapshot', message => message.snapshot.serverTime > moved.snapshot.serverTime + 400, stoppedMark);
  const stoppedPlayer = stopped.snapshot.players.find(player => player.id === owner.profile.id)!;
  assert.equal(stoppedPlayer.vx, 0); assert.equal(stoppedPlayer.vz, 0, 'Dropped inputs must not keep moving a disconnected controller.');
  const friendDisconnectedMark = host.mark(); guest.close();
  await host.wait('room', message => message.room.players.some(player => player.id === friend.profile.id && !player.connected), friendDisconnectedMark);
  // A refused start during play must not prune a rival who is inside reconnect grace.
  await host.command({ type: 'start' }, 'error');
  const resumed = await f.connect(friend.token);
  const resumedRoom = await resumed.wait('room', message => message.room.id === created.room.id);
  assert.equal(resumedRoom.room.phase, 'playing');
  assert.equal(resumedRoom.room.players.filter(player => player.id === friend.profile.id).length, 1);
  const resumedWorld = await resumed.wait('snapshot', message => message.snapshot.phase === 'playing');
  assert.deepEqual(new Set(resumedWorld.snapshot.players.map(player => player.id)), new Set([owner.profile.id, friend.profile.id]));
});

test('private room capacity is eight and rejected ninth player keeps their own room', async t => {
  const f = await fixture(t);
  const identities = [];
  for (let index = 0; index < 9; index++) identities.push(await f.profile(`Competitor ${index + 1}`));
  const peers = [];
  for (const identity of identities) peers.push(await f.connect(identity.token));
  const target = await peers[0]!.command({ type: 'create', ranked: false }, 'room');
  for (let index = 1; index < 8; index++) {
    await peers[index]!.command({ type: 'join', code: target.room.code }, 'room', message => message.room.players.length === index + 1);
  }
  const ninth = peers[8]!;
  const own = await ninth.command({ type: 'create', ranked: false }, 'room');
  await ninth.command({ type: 'join', code: target.room.code }, 'error');
  const ownMark = ninth.mark();
  ninth.send({ type: 'ping', t: 123 });
  assert.equal((await ninth.wait('pong', () => true, ownMark)).t, 123);
  // A failed move must leave the current room attached, rather than stranding its host.
  const stillOwner = await ninth.command({ type: 'start' }, 'error');
  assert.match(stillOwner.message, /friend|player|invite|two|2/i);
  assert.notEqual(own.room.id, target.room.id);
  const hostLatest = peers[0]!.messages.filter(message => message.type === 'room').at(-1)!;
  assert.equal(hostLatest.room.players.length, RULES.maxPlayers);
});
