import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES, type Crew, type InputFrame, type LeaderboardEntry, type MatchHistory, type RoomSnapshot, type WorldSnapshot } from '../../shared/protocol.js';
import { fixture, startReady, type Peer } from './helpers.js';

const input = (seq: number): InputFrame => ({ seq, moveX: 1, moveZ: 1, yaw: 1, pitch: .2, fire: true, aim: true, jump: true, sprint: true, reload: true, slot: 2 });
const preparationId = (room: RoomSnapshot) => {
  assert.equal(room.phase, 'preparing');
  assert.ok(room.preparation?.id, 'An attempt needs its own server-issued readiness nonce.');
  assert.ok(room.preparation.expiresAt > Date.now());
  assert.ok(room.preparation.expiresAt <= Date.now() + 45_100, 'Preparation remains bounded.');
  return room.preparation.id;
};
const ready = (peer: Peer, id: string, value = true) => peer.send({ type: 'ready', preparationId: id, ready: value });
const latestRoom = (peer: Peer) => {
  const message = peer.messages.findLast(message => message.type === 'room');
  assert.ok(message?.type === 'room'); return message.room;
};
const playerReady = (peer: Peer, id: string, value: boolean, after: number) => peer.wait('room', message => message.room.players.some(player => player.id === id && player.ready === value), after);
const barrier = async (peer: Peer) => { const nonce = Date.now(); await peer.command({ type: 'ping', t: nonce }, 'pong', message => message.t === nonce); };
const freshAfter = (peer: Peer, at: number, after: number) => peer.wait('snapshot', message => message.snapshot.serverTime >= at, after);
const spawnState = (snapshot: WorldSnapshot) => snapshot.players.map(player => ({ id: player.id, x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, health: player.health, shield: player.shield, kills: player.kills, deaths: player.deaths, ammoAR: player.ammoAR, ammoShotgun: player.ammoShotgun, heals: player.heals, slot: player.slot }));

test('private readiness waits beyond the old countdown and rejects outsiders and pre-start action latches', async t => {
  const f = await fixture(t);
  const owner = await f.profile('Ready Owner'), rival = await f.profile('Ready Rival'), outsider = await f.profile('Ready Outsider');
  const response = await f.request('/api/crews', { token: owner.token, body: { name: 'Ready Family' } });
  const { crew } = await response.json() as { crew: Crew };
  assert.ok((await f.request('/api/crews/join', { token: rival.token, body: { invite: crew.invite } })).ok);
  const host = await f.connect(owner.token), guest = await f.connect(rival.token), other = await f.connect(outsider.token);
  const created = await host.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room');
  const otherRoom = await other.command({ type: 'create', ranked: false }, 'room');
  const initialMark = host.mark();
  const prepared = await host.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const id = preparationId(prepared.room);
  assert.ok(prepared.room.players.every(player => player.ready === false));
  const initial = await host.wait('snapshot', message => message.snapshot.phase === 'preparing', initialMark);
  assert.equal(initial.snapshot.roundId, id, 'The prepared world must prove this exact readiness attempt.');
  const mark = host.mark(); ready(host, id);
  await playerReady(host, owner.profile.id, true, mark);
  // A private-room nonce is not authority to ready another room or bypass membership.
  ready(other, id); await barrier(other);
  await other.command({ type: 'join', code: created.room.code }, 'error');
  assert.ok((await f.request('/api/crews/join', { token: outsider.token, body: { invite: crew.invite } })).ok);
  await other.command({ type: 'join', code: created.room.code }, 'error');
  assert.equal(latestRoom(other).id, otherRoom.room.id, 'Failed admission preserves the outsider\'s existing room.');
  await guest.command({ type: 'start' }, 'error');
  const waiting = await freshAfter(host, initial.snapshot.serverTime + RULES.countdownMs + 200, mark);
  assert.equal(waiting.snapshot.phase, 'preparing', 'One ready player cannot run out the old countdown while a rival loads.');
  assert.equal(waiting.snapshot.timeRemaining, RULES.matchSeconds);
  assert.deepEqual(spawnState(waiting.snapshot), spawnState(initial.snapshot));
  assert.equal(host.messages.slice(mark).some(message => (message.type === 'snapshot' && message.snapshot.phase === 'playing') || (message.type === 'room' && message.room.phase === 'countdown')), false);

  host.send({ type: 'input', input: input(1) });
  const countdownMark = host.mark(), acceptedAt = Date.now();
  ready(guest, id);
  await host.wait('room', message => message.room.phase === 'countdown', countdownMark);
  const countdown = await host.wait('snapshot', message => message.snapshot.phase === 'countdown', countdownMark);
  assert.equal(countdown.snapshot.roundId, id, 'Preparation and countdown describe the same reset world.');
  assert.ok(countdown.snapshot.timeRemaining > 2.5 && countdown.snapshot.timeRemaining <= 3, 'All ready starts a complete new three-second countdown.');
  // Send all action edges immediately before play. A disabled UI alone cannot
  // prevent a hostile client from queuing a first-frame shot or jump.
  const nearStart = await host.wait('snapshot', message => message.snapshot.phase === 'countdown' && message.snapshot.timeRemaining < .2, countdownMark);
  host.send({ type: 'input', input: input(2) });
  guest.send({ type: 'input', input: input(1) });
  const playing = await host.wait('snapshot', message => message.snapshot.phase === 'playing', countdownMark);
  assert.equal(playing.snapshot.roundId, id);
  assert.ok(playing.snapshot.serverTime >= acceptedAt + RULES.countdownMs - 20, 'The new countdown is not shortened by preparation time.');
  assert.ok(playing.snapshot.serverTime > nearStart.snapshot.serverTime);
  assert.deepEqual(spawnState(playing.snapshot), spawnState(initial.snapshot), 'Preparation/countdown inputs must not change first-frame position, view, loadout or score.');
  assert.equal(host.messages.slice(initialMark).some(message => message.type === 'event' && ['shot', 'damage', 'heal', 'elimination'].includes(message.event.type)), false);
});

test('withdrawal and replaced-session recovery require a fresh acknowledgement without losing the reserved roster', async t => {
  const f = await fixture(t);
  const owner = await f.profile('Recovery Ready'), rival = await f.profile('Recovery Rival');
  const host = await f.connect(owner.token), guest = await f.connect(rival.token);
  const created = await host.command({ type: 'create', ranked: false }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room');
  const prepared = await host.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const id = preparationId(prepared.room);
  const readyMark = host.mark(); ready(guest, id);
  await playerReady(host, rival.profile.id, true, readyMark);
  const withdrawnMark = host.mark(); ready(guest, id, false);
  const withdrawn = await playerReady(host, rival.profile.id, false, withdrawnMark);
  assert.equal(withdrawn.room.phase, 'preparing'); assert.equal(withdrawn.room.preparation?.id, id);
  const againMark = host.mark(); ready(guest, id);
  await playerReady(host, rival.profile.id, true, againMark);

  // A second authenticated tab retires the old connection and must not inherit
  // that tab's already-rendered / already-captured readiness acknowledgement.
  const replacementMark = host.mark();
  const oldClosed = new Promise<number>(resolve => guest.socket.once('close', code => resolve(code)));
  const replacement = await f.connect(rival.token);
  assert.equal(await oldClosed, 4001);
  const recovered = await replacement.wait('room', message => message.room.id === created.room.id && message.room.phase === 'preparing');
  assert.equal(recovered.room.preparation?.id, id);
  assert.equal(recovered.room.players.filter(player => player.id === rival.profile.id).length, 1);
  assert.equal(recovered.room.players.find(player => player.id === rival.profile.id)?.ready, false);
  await playerReady(host, rival.profile.id, false, replacementMark);
  const hostReadyMark = host.mark(); ready(host, id);
  await playerReady(host, owner.profile.id, true, hostReadyMark);
  const malformedMark = replacement.mark();
  replacement.socket.send(JSON.stringify({ type: 'ready', preparationId: id, ready: 'true' }));
  await replacement.wait('error', () => true, malformedMark);
  await replacement.command({ type: 'ready', preparationId: `${id}-old`, ready: true }, 'error', message => message.code === 'PREPARATION_STALE');
  await barrier(host);
  assert.equal(latestRoom(host).phase, 'preparing');
  assert.equal(latestRoom(host).players.find(player => player.id === rival.profile.id)?.ready, false);
  const countdownMark = host.mark(); ready(replacement, id);
  await host.wait('room', message => message.room.phase === 'countdown', countdownMark);
  const countdown = await host.wait('snapshot', message => message.snapshot.phase === 'countdown', countdownMark);
  assert.ok(countdown.snapshot.timeRemaining > 2.5);
  await replacement.command({ type: 'ready', preparationId: id, ready: false }, 'error', message => message.code === 'PREPARATION_STALE');
  const later = await freshAfter(host, countdown.snapshot.serverTime + 200, countdownMark);
  assert.equal(later.snapshot.phase, 'countdown');
  assert.ok(later.snapshot.timeRemaining < countdown.snapshot.timeRemaining, 'A stale readiness message does not reset an already admitted round.');
});

test('a preparing host can leave without starting a match or stranding the next host', async t => {
  const f = await fixture(t);
  const owner = await f.profile('Departing Host'), friend = await f.profile('Next Host');
  const host = await f.connect(owner.token), guest = await f.connect(friend.token);
  const created = await host.command({ type: 'create', ranked: false }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room');
  const prepared = await host.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const oldId = preparationId(prepared.room);
  const guestReadyMark = guest.mark(); ready(guest, oldId);
  await playerReady(guest, friend.profile.id, true, guestReadyMark);
  const leaveMark = guest.mark(); host.send({ type: 'leave' });
  await guest.wait('error', message => message.code === 'PREPARATION_CANCELLED', leaveMark);
  const lobby = await guest.wait('room', message => message.room.phase === 'waiting', leaveMark);
  assert.equal(lobby.room.hostId, friend.profile.id); assert.equal(lobby.room.players.length, 1); assert.equal(lobby.room.preparation, undefined);
  assert.equal(guest.messages.slice(leaveMark).some(message => message.type === 'event' && message.event.type === 'match-end'), false, 'A cancelled preparation is not a played result.');
  await guest.command({ type: 'start' }, 'error');
  const returned = await host.command({ type: 'join', code: created.room.code }, 'room');
  assert.equal(returned.room.hostId, friend.profile.id);
  const restarted = await guest.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const nextId = preparationId(restarted.room); assert.notEqual(nextId, oldId);
  await guest.command({ type: 'ready', preparationId: oldId, ready: true }, 'error', message => message.code === 'PREPARATION_STALE');
  assert.ok(latestRoom(guest).players.every(player => player.ready === false));
  const countdownMark = guest.mark(); ready(guest, nextId); ready(host, nextId);
  await guest.wait('room', message => message.room.phase === 'countdown', countdownMark);
});

test('a completed abandoned round requires a fresh rematch readiness nonce and cannot persist ranked results', async t => {
  const f = await fixture(t);
  const owner = await f.profile('Rematch Ready'), returning = await f.profile('Returning Ready'), leaving = await f.profile('Leaving Ready');
  const response = await f.request('/api/crews', { token: owner.token, body: { name: 'Rematch Ready Crew' } });
  const { crew } = await response.json() as { crew: Crew };
  for (const identity of [returning, leaving]) assert.ok((await f.request('/api/crews/join', { token: identity.token, body: { invite: crew.invite } })).ok);
  const host = await f.connect(owner.token), reserve = await f.connect(returning.token), departing = await f.connect(leaving.token);
  const created = await host.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  for (const peer of [reserve, departing]) await peer.command({ type: 'join', code: created.room.code }, 'room');
  const first = await host.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const oldId = preparationId(first.room), firstMark = host.mark();
  for (const peer of [host, reserve, departing]) ready(peer, oldId);
  await host.wait('snapshot', message => message.snapshot.phase === 'playing', firstMark);
  const disconnectedMark = host.mark(); reserve.close();
  await host.wait('room', message => message.room.players.some(player => player.id === returning.profile.id && !player.connected), disconnectedMark);
  const finishMark = host.mark(); departing.send({ type: 'leave' });
  const ended = await host.wait('event', message => message.event.type === 'match-end', finishMark);
  assert.equal(ended.event.type, 'match-end');
  if (ended.event.type !== 'match-end') return;
  assert.equal(ended.event.ranked, false); assert.deepEqual(ended.event.winnerIds, []);
  // The retained, genuinely disconnected identity can recover after the round;
  // no direct engine mutation or simulated match clock is needed for this path.
  const recovered = await f.connect(returning.token);
  await recovered.wait('room', message => message.room.phase === 'finished' && message.room.id === created.room.id);
  const rematchMark = host.mark();
  const rematch = await host.command({ type: 'rematch' }, 'room', message => message.room.phase === 'preparing');
  const nextId = preparationId(rematch.room); assert.notEqual(nextId, oldId);
  assert.ok(rematch.room.players.every(player => !player.bot && player.connected && player.ready === false));
  ready(host, oldId); ready(recovered, oldId); await barrier(host); await barrier(recovered);
  assert.equal(latestRoom(host).phase, 'preparing');
  assert.ok(latestRoom(host).players.every(player => player.ready === false), 'Previous round readiness cannot satisfy the rematch.');
  for (const peer of [host, recovered]) ready(peer, nextId);
  const countdown = await host.wait('snapshot', message => message.snapshot.phase === 'countdown', rematchMark);
  assert.equal(countdown.snapshot.roundId, nextId, 'A rematch cannot reuse the previous rendered round proof.');
  assert.ok(countdown.snapshot.timeRemaining > 2.5);
  assert.ok(countdown.snapshot.players.every(player => player.health === RULES.health && player.shield === RULES.shield && player.ammoAR === RULES.arMagazine && player.ammoShotgun === RULES.shotgunMagazine && player.heals === RULES.healCharges && player.slot === 1 && player.kills === 0 && player.deaths === 0));
  for (const period of ['all', 'month']) {
    const response = await f.request(`/api/leaderboard?crewId=${crew.id}&period=${period}`, { token: owner.token });
    assert.ok(response.ok);
    const board = await response.json() as { entries: LeaderboardEntry[]; history: MatchHistory[] };
    assert.deepEqual(board.history, []); assert.ok(board.entries.every(entry => entry.matches === 0 && entry.wins === 0));
  }
});

test('a stale-map reconnect cannot move or shoot in an already playing round', async t => {
  const f = await fixture(t), identity = await f.profile('Map Recovery');
  const modern = await f.connect(identity.token);
  await modern.command({ type: 'create', ranked: false, practice: true }, 'room');
  await startReady(modern, [modern]);
  await modern.wait('snapshot', message => message.snapshot.phase === 'playing');
  const stale = await f.connect();
  await stale.command({ type: 'hello', token: identity.token, readyProtocol: 1, worldVersion: 'sunbreak-coastal-v1' }, 'welcome');
  await stale.wait('room', message => message.room.phase === 'playing');
  const mark = stale.mark();
  await stale.command({ type: 'input', input: input(1) }, 'error', message => message.code === 'GAME_UPDATE_REQUIRED');
  const observed = await stale.wait('snapshot', message => message.snapshot.players.some(player => player.id === identity.profile.id), mark);
  const player = observed.snapshot.players.find(player => player.id === identity.profile.id)!;
  assert.equal(player.vx, 0); assert.equal(player.vz, 0); assert.equal(player.lastInputSeq, 0);
  assert.ok(!stale.messages.slice(mark).some(message => message.type === 'event' && message.event.type === 'shot' && message.event.playerId === identity.profile.id));
});

test('readiness-capable pages with missing or stale map versions cannot start a mismatched world', async t => {
  const f = await fixture(t);
  for (const worldVersion of [undefined, 'sunbreak-coastal-v1', 'future-map']) {
    const identity = await f.profile('Map Compatibility');
    const peer = await f.connect();
    await peer.command({ type: 'hello', token: identity.token, readyProtocol: 1, worldVersion }, 'welcome');
    await peer.command({ type: 'create', ranked: false, practice: true }, 'room');
    const error = await peer.command({ type: 'start' }, 'error');
    assert.equal(error.code, 'GAME_UPDATE_REQUIRED'); assert.match(error.message, /refresh/i);
    assert.equal(latestRoom(peer).phase, 'waiting');
    peer.send({ type: 'leave' });
  }
});

test('mixed old and new pages receive an update instruction before start or rematch can mutate the round', async t => {
  const f = await fixture(t);
  const oldIdentity = await f.profile('Legacy Page'), modernIdentity = await f.profile('Modern Page'), reserveIdentity = await f.profile('Reserved Page');
  const response = await f.request('/api/crews', { token: modernIdentity.token, body: { name: 'Compatible Crew' } });
  const { crew } = await response.json() as { crew: Crew };
  for (const identity of [oldIdentity, reserveIdentity]) assert.ok((await f.request('/api/crews/join', { token: identity.token, body: { invite: crew.invite } })).ok);
  const oldPage = await f.connect();
  await oldPage.command({ type: 'hello', token: oldIdentity.token }, 'welcome');
  const modern = await f.connect(modernIdentity.token), reserve = await f.connect(reserveIdentity.token);
  const oldOwned = await oldPage.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  await modern.command({ type: 'join', code: oldOwned.room.code }, 'room');
  const beforeOldStart = await oldPage.wait('snapshot', message => message.snapshot.phase === 'waiting' && message.snapshot.players.length === 2);
  const oldMark = oldPage.mark();
  // Capability is captured by authentication, not accepted on arbitrary later commands.
  oldPage.socket.send(JSON.stringify({ type: 'start', readyProtocol: 1 }));
  const deniedHost = await oldPage.wait('error', message => message.code === 'GAME_UPDATE_REQUIRED', oldMark);
  assert.match(deniedHost.message, /refresh/i);
  const unchanged = await freshAfter(oldPage, beforeOldStart.snapshot.serverTime + 100, oldMark);
  assert.equal(unchanged.snapshot.phase, 'waiting'); assert.equal(unchanged.snapshot.timeRemaining, RULES.matchSeconds);
  assert.deepEqual(spawnState(unchanged.snapshot), spawnState(beforeOldStart.snapshot));
  assert.equal(latestRoom(oldPage).preparation, undefined);

  modern.send({ type: 'leave' });
  const newOwned = await modern.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  await oldPage.command({ type: 'join', code: newOwned.room.code }, 'room');
  await reserve.command({ type: 'join', code: newOwned.room.code }, 'room');
  await modern.command({ type: 'start' }, 'error', message => message.code === 'GAME_UPDATE_REQUIRED');
  assert.equal(latestRoom(modern).phase, 'waiting'); assert.equal(latestRoom(modern).preparation, undefined);
  const refreshed = await f.connect(oldIdentity.token);
  await refreshed.wait('room', message => message.room.id === newOwned.room.id && message.room.phase === 'waiting');
  const preparation = await modern.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const firstId = preparationId(preparation.room), startMark = modern.mark();
  for (const peer of [modern, refreshed, reserve]) ready(peer, firstId);
  await modern.wait('snapshot', message => message.snapshot.phase === 'playing', startMark);

  const disconnectedMark = modern.mark(); reserve.close();
  await modern.wait('room', message => message.room.players.some(player => player.id === reserveIdentity.profile.id && !player.connected), disconnectedMark);
  const endMark = modern.mark(); refreshed.send({ type: 'leave' });
  const end = await modern.wait('event', message => message.event.type === 'match-end', endMark);
  assert.equal(end.event.type, 'match-end');
  if (end.event.type !== 'match-end') return;
  assert.equal(end.event.ranked, false);
  const legacyRecovery = await f.connect();
  await legacyRecovery.command({ type: 'hello', token: reserveIdentity.token }, 'welcome');
  await legacyRecovery.wait('room', message => message.room.id === newOwned.room.id && message.room.phase === 'finished');
  const replay = await legacyRecovery.wait('event', message => message.event.type === 'match-end');
  assert.deepEqual(replay.event, end.event, 'A legacy page may still recover its completed result.');
  const beforeRematch = await modern.wait('snapshot', message => message.snapshot.phase === 'finished' && message.snapshot.players.some(player => player.id === reserveIdentity.profile.id && player.connected), endMark);
  const deniedMark = modern.mark();
  await modern.command({ type: 'rematch' }, 'error', message => message.code === 'GAME_UPDATE_REQUIRED');
  const afterRematch = await freshAfter(modern, beforeRematch.snapshot.serverTime + 100, deniedMark);
  assert.equal(afterRematch.snapshot.phase, 'finished');
  assert.deepEqual(spawnState(afterRematch.snapshot), spawnState(beforeRematch.snapshot));
  assert.deepEqual(afterRematch.snapshot.winnerIds, beforeRematch.snapshot.winnerIds);
  assert.equal(latestRoom(modern).preparation, undefined);
  assert.equal(modern.messages.slice(deniedMark).some(message => message.type === 'event' && message.event.type === 'match-end'), false);
  for (const period of ['all', 'month']) {
    const response = await f.request(`/api/leaderboard?crewId=${crew.id}&period=${period}`, { token: modernIdentity.token });
    const board = await response.json() as { entries: LeaderboardEntry[]; history: MatchHistory[] };
    assert.deepEqual(board.history, []); assert.ok(board.entries.every(entry => entry.matches === 0 && entry.wins === 0));
  }
  const recoveredModern = await f.connect(reserveIdentity.token);
  await recoveredModern.wait('room', message => message.room.id === newOwned.room.id && message.room.phase === 'finished');
  const rematch = await modern.command({ type: 'rematch' }, 'room', message => message.room.phase === 'preparing');
  const rematchId = preparationId(rematch.room); assert.notEqual(rematchId, firstId);
  assert.ok(rematch.room.players.every(player => player.ready === false));
  const acknowledgedMark = modern.mark(); ready(modern, rematchId);
  await playerReady(modern, modernIdentity.profile.id, true, acknowledgedMark);
  const downgradeMark = modern.mark();
  const downgraded = await f.connect();
  await downgraded.command({ type: 'hello', token: reserveIdentity.token }, 'welcome');
  await modern.wait('error', message => message.code === 'GAME_UPDATE_REQUIRED', downgradeMark);
  const cancelled = await modern.wait('room', message => message.room.phase === 'waiting', downgradeMark);
  assert.equal(cancelled.room.preparation, undefined);
  assert.equal(cancelled.room.players.length, 2, 'A retained old page remains in the lobby so it can refresh.');
  assert.equal(modern.messages.slice(downgradeMark).some(message => message.type === 'event' && message.event.type === 'match-end'), false);
  await modern.command({ type: 'ready', preparationId: rematchId, ready: true }, 'error', message => message.code === 'PREPARATION_STALE');
  const refreshedAgain = await f.connect(reserveIdentity.token);
  await refreshedAgain.wait('room', message => message.room.id === newOwned.room.id && message.room.phase === 'waiting');
  const retry = await modern.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  assert.notEqual(preparationId(retry.room), rematchId);
  assert.ok(retry.room.players.every(player => player.ready === false));
});
